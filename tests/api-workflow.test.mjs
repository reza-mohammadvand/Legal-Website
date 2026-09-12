import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const cwd = fileURLToPath(root);
let testCwd;

function resetDatabase() {
  const result = spawnSync(process.execPath, [join(cwd, "server/reset-db.mjs")], {
    cwd: testCwd,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });

  assert.equal(
    result.status,
    0,
    `Database reset failed.\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`,
  );
}

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startApi(port) {
  const child = spawn(process.execPath, [join(cwd, "server/local-api.mjs")], {
    cwd: testCwd,
    env: { ...process.env, DADRAH_API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const output = { stdout: "", stderr: "", error: null };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  child.on("error", (error) => { output.error = error; });
  return { child, output };
}

async function stopApi(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 40 && child.exitCode === null && child.signalCode === null; attempt += 1) {
    await delay(50);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function waitForApi(baseUrl, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (output.error) throw output.error;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`API exited before becoming ready.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The listener may need a few more milliseconds after the process starts.
    }
    await delay(50);
  }
  throw new Error(`API did not become ready.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
}

function apiClient(baseUrl) {
  return async (path, { method = "GET", token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const raw = await response.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        assert.fail(`${method} ${path} returned non-JSON content: ${raw.slice(0, 200)}`);
      }
    }
    return { status: response.status, headers: response.headers, body: data };
  };
}

function expectStatus(response, expected, label) {
  assert.equal(
    response.status,
    expected,
    `${label} returned ${response.status}: ${JSON.stringify(response.body)}`,
  );
  return response.body;
}

async function login(api, username, password, expectedRole) {
  const signedIn = expectStatus(await api("/api/auth/login", {
    method: "POST",
    body: { username, password, expectedRole },
  }), 200, `Login for ${expectedRole}`);
  assert.equal(signedIn.user?.role, expectedRole);
  assert.equal(typeof signedIn.token, "string");
  assert.ok(signedIn.token.length >= 32);

  const me = expectStatus(await api("/api/me", { token: signedIn.token }), 200, `/api/me for ${expectedRole}`);
  assert.equal(me.user?.role, expectedRole);
  assert.ok(Number.isSafeInteger(me.user?.id));
  return { token: signedIn.token, user: me.user };
}

test("the local API completes the legal consultation workflow securely", {
  concurrency: false,
  timeout: 45_000,
}, async () => {
  let apiProcess;
  let processOutput;

  testCwd = mkdtempSync(join(tmpdir(), "dadrah-api-test-"));
  resetDatabase();
  try {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    ({ child: apiProcess, output: processOutput } = startApi(port));
    await waitForApi(baseUrl, apiProcess, processOutput);
    const api = apiClient(baseUrl);
    const upload = async (path, token, kind, questionId, consultationId) => {
      const form = new FormData();
      form.append("file", new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6gAAAABJRU5ErkJggg==", "base64")], { type: "image/png" }), "image.png");
      if (kind) form.append("kind", kind);
      if (questionId) form.append("questionId", String(questionId));
      if (consultationId) form.append("consultationId", String(consultationId));
      const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      return { status: response.status, body: await response.json() };
    };

    const health = expectStatus(await api("/api/health"), 200, "Health check");
    assert.equal(health.ok, true);
    assert.equal(typeof health.database, "string");

    const bootstrap = expectStatus(await api("/api/bootstrap"), 200, "Public bootstrap");
    for (const collection of ["lawyers", "articles", "questions", "services", "faqs", "reviews"]) {
      assert.ok(Array.isArray(bootstrap[collection]), `bootstrap.${collection} must be an array`);
    }
    assert.ok(bootstrap.lawyers.length >= 1);
    assert.equal(typeof bootstrap.settings, "object");
    assert.ok(bootstrap.services.every((item) => Number.isSafeInteger(item.id) && typeof item.back_description === "string"));
    assert.ok(bootstrap.services.every((item) => Array.isArray(JSON.parse(item.case_types))));
    assert.ok(bootstrap.lawyers.every((item) => typeof item.specialty_ids === "string"));
    for (const key of ["logo_light_url", "logo_dark_url", "favicon_url", "hero_images"]) assert.ok(Object.hasOwn(bootstrap.settings, key));

    expectStatus(await api("/api/dashboard"), 401, "Anonymous dashboard request");
    expectStatus(await api("/api/questions", {
      method: "POST",
      body: { topic: "Unauthorized", body: "This question must not be accepted without a session." },
    }), 401, "Anonymous question request");

    expectStatus(await api("/api/auth/register", { method: "POST", body: { username: "workflow-client", password: "Client123!", firstName: "Test", lastName: "Client", phone: "09123456789", email: "workflow@example.test", role: "client" } }), 201, "Register a fresh client");
    const client = await login(api, "workflow-client", "Client123!", "client");
    const lawyer = await login(api, "lawyer", "Lawyer123!", "lawyer");
    const admin = await login(api, "admin", "Admin123!", "admin");

    expectStatus(await upload("/api/site-media", lawyer.token), 403, "A lawyer cannot upload site branding");
    const siteImage = expectStatus(await upload("/api/site-media", admin.token), 201, "Administrator uploads site branding");
    assert.equal((await fetch(`${baseUrl}${siteImage.url}`)).status, 200);
    for (const key of ["logo_light_url", "logo_dark_url", "favicon_url"]) {
      expectStatus(await api("/api/admin/action", { method: "POST", token: admin.token, body: { action: "setting", key, value: siteImage.url } }), 200, `Save ${key}`);
    }
    expectStatus(await api("/api/admin/action", { method: "POST", token: admin.token, body: { action: "setting", key: "hero_images", value: JSON.stringify([siteImage.url]) } }), 200, "Save home hero images");
    expectStatus(await api("/api/admin/action", { method: "POST", token: admin.token, body: { action: "setting", key: "logo_light_url", value: "https://example.test/untrusted.png" } }), 400, "Reject an external branding URL");
    const brandedBootstrap = expectStatus(await api("/api/bootstrap"), 200, "Public branding settings");
    assert.equal(brandedBootstrap.settings.logo_light_url, siteImage.url);
    assert.equal(brandedBootstrap.settings.logo_dark_url, siteImage.url);
    assert.equal(brandedBootstrap.settings.favicon_url, siteImage.url);
    assert.deepEqual(JSON.parse(brandedBootstrap.settings.hero_images), [siteImage.url]);

    const specialtyTitle = "Workflow Specialty";
    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: {
        action: "service-save",
        title: specialtyTitle,
        description: "A focused specialty shown on the front of its card.",
        backDescription: "Administrator controlled details shown after the card flips.",
        caseTypes: ["Case type one", "Case type two"],
        icon: "scale",
        sortOrder: 77,
        active: true,
      },
    }), 200, "Administrator creates a specialty");
    const specialtyBootstrap = expectStatus(await api("/api/bootstrap"), 200, "Public specialty catalog");
    const customSpecialty = specialtyBootstrap.services.find((item) => item.title === specialtyTitle);
    assert.ok(customSpecialty);
    assert.equal(customSpecialty.back_description, "Administrator controlled details shown after the card flips.");
    assert.deepEqual(JSON.parse(customSpecialty.case_types), ["Case type one", "Case type two"]);

    const lawyerDashboard = expectStatus(await api("/api/dashboard", { token: lawyer.token }), 200, "Lawyer dashboard");
    assert.equal(lawyerDashboard.role, "lawyer");
    assert.ok(Number.isSafeInteger(lawyerDashboard.profile?.id));
    const lawyerId = lawyerDashboard.profile.id;
    const publicLawyer = bootstrap.lawyers.find((item) => item.id === lawyerId);
    assert.ok(publicLawyer, "The signed-in lawyer must be present in the public directory");

    const questionCreated = expectStatus(await api("/api/questions", {
      method: "POST",
      token: client.token,
      body: {
        topic: "Contract termination",
        body: "What documents are needed before starting a contract termination claim?",
        publishAllowed: false,
        urgent: true,
      },
    }), 201, "Create free question");
    assert.equal(questionCreated.status, "assigned");
    assert.equal(questionCreated.assignedLawyerIds.length, 3);
    assert.ok(Number.isSafeInteger(questionCreated.id));

    const assignedIds = [lawyerId, ...bootstrap.lawyers.filter((item) => item.id !== lawyerId).slice(0, 2).map((item) => item.id)];
    const assignment = expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: { action: "assign-question", questionId: questionCreated.id, lawyerIds: assignedIds },
    }), 200, "Assign question");
    assert.deepEqual([...assignment.assigned].sort(), [...assignedIds].sort());

    const assignedDashboard = expectStatus(await api("/api/dashboard", { token: lawyer.token }), 200, "Assigned lawyer dashboard");
    const assignedQuestion = assignedDashboard.questions.find((item) => item.id === questionCreated.id);
    assert.ok(assignedQuestion);
    assert.equal(assignedQuestion.assignment_status, "assigned");

    const answered = expectStatus(await api("/api/answers", {
      method: "POST",
      token: lawyer.token,
      body: {
        questionId: questionCreated.id,
        body: "Gather the signed agreement, payment records, notices, and all written correspondence.",
      },
    }), 201, "Answer assigned question");
    assert.ok(Number.isSafeInteger(answered.id));

    const clientAfterAnswer = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Client dashboard after answer");
    const answeredQuestion = clientAfterAnswer.questions.find((item) => item.id === questionCreated.id);
    assert.ok(answeredQuestion);
    assert.equal(answeredQuestion.status, "assigned", "Other assigned lawyers may still be preparing their answers");
    assert.equal(answeredQuestion.closed, true, "The first answer is ready for the client immediately");
    assert.ok(Array.isArray(answeredQuestion.answers));
    assert.equal(answeredQuestion.answers.length, 1);
    assert.equal(answeredQuestion.answers[0].id, answered.id);
    assert.ok(clientAfterAnswer.notificationItems.some((item) => item.id === `answer-${answered.id}`));

    const adminAfterAnswer = expectStatus(await api("/api/dashboard", { token: admin.token }), 200, "Admin sees question answers");
    const managedQuestion = adminAfterAnswer.questions.find((item) => item.id === questionCreated.id);
    assert.ok(managedQuestion);
    assert.equal(managedQuestion.answers.length, 1);
    assert.equal(managedQuestion.answers[0].published, 0);
    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: { action: "moderate-answer", answerId: answered.id, published: true },
    }), 409, "Admin cannot publish an answer without client consent");

    const replacementLawyer = bootstrap.lawyers.find((item) => item.id !== lawyerId);
    assert.ok(replacementLawyer, "Seed data must expose another verified lawyer for reassignment");
    const directQuestion = expectStatus(await api("/api/questions", {
      method: "POST",
      token: client.token,
      body: {
        topic: "Direct question reassignment",
        body: "This direct question will be reassigned to verify that withdrawn access is revoked.",
        lawyerId,
        publishAllowed: false,
      },
    }), 201, "Create direct question");
    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: { action: "assign-question", questionId: directQuestion.id, lawyerIds: [replacementLawyer.id] },
    }), 200, "Reassign direct question");
    expectStatus(await api("/api/answers", {
      method: "POST",
      token: lawyer.token,
      body: {
        questionId: directQuestion.id,
        body: "A lawyer whose assignment was withdrawn must not be able to submit this answer.",
      },
    }), 403, "Withdrawn lawyer cannot answer reassigned direct question");

    const replacementAccount = await login(api, `lawyer${replacementLawyer.id}`, "Lawyer123!", "lawyer");
    const cancelledQuestion = expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: { action: "cancel-question", questionId: directQuestion.id },
    }), 200, "Admin cancels the whole free question");
    assert.equal(cancelledQuestion.status, "cancelled");
    assert.equal(cancelledQuestion.withdrawn, 1);
    const cancelledQuestionAgain = expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: { action: "cancel-question", questionId: directQuestion.id },
    }), 200, "Question cancellation is idempotent");
    assert.equal(cancelledQuestionAgain.idempotent, true);
    assert.equal(cancelledQuestionAgain.withdrawn, 0);
    const cancelledForClient = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Client sees cancelled question");
    assert.equal(cancelledForClient.questions.find((item) => item.id === directQuestion.id)?.status, "cancelled");
    assert.equal(cancelledForClient.questions.find((item) => item.id === directQuestion.id)?.closed, true);
    assert.ok(cancelledForClient.notificationItems.some((item) => item.id === `question-cancelled-${directQuestion.id}`));
    const cancelledForLawyer = expectStatus(await api("/api/dashboard", { token: replacementAccount.token }), 200, "Assigned lawyer is notified of cancellation");
    assert.equal(cancelledForLawyer.questions.find((item) => item.id === directQuestion.id)?.assignment_status, "withdrawn");
    assert.ok(cancelledForLawyer.notificationItems.some((item) => item.id === `question-cancelled-${directQuestion.id}`));
    expectStatus(await api("/api/answers", {
      method: "POST",
      token: replacementAccount.token,
      body: { questionId: directQuestion.id, body: "This answer must be rejected because the question has been cancelled." },
    }), 403, "Cancelled question cannot receive a new answer");
    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: { action: "assign-question", questionId: directQuestion.id, lawyerIds: [replacementLawyer.id] },
    }), 404, "Cancelled question cannot be assigned again");

    const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const pendingPhone = expectStatus(await api("/api/consultations", {
      method: "POST",
      token: client.token,
      body: {
        type: "phone",
        topic: "A consultation that uses the two-step checkout",
        lawyerId,
        scheduledAt,
        amount: 1,
        deferPayment: true,
      },
    }), 201, "Create a pending phone checkout");
    assert.equal(pendingPhone.amount, publicLawyer.phone_price);
    assert.equal(pendingPhone.status, "pending_payment");
    assert.equal(pendingPhone.paymentStatus, "pending");
    assert.equal(pendingPhone.paymentRequired, true);
    assert.equal(pendingPhone.checkoutPath, `/api/checkout/${pendingPhone.trackingCode}`);

    expectStatus(await api(pendingPhone.checkoutPath), 401, "Anonymous cannot inspect checkout");
    expectStatus(await api(pendingPhone.checkoutPath, { token: lawyer.token }), 403, "Unrelated lawyer cannot inspect checkout");
    const adminCheckout = expectStatus(await api(pendingPhone.checkoutPath, { token: admin.token }), 200, "Admin can inspect checkout");
    assert.equal(adminCheckout.order.amount, publicLawyer.phone_price);
    assert.equal(adminCheckout.order.status, "pending");
    assert.equal(adminCheckout.consultation.status, "pending_payment");
    expectStatus(await api(`${pendingPhone.checkoutPath}/pay`, {
      method: "POST",
      token: admin.token,
    }), 403, "Admin cannot pay a client's checkout");

    const ownerCheckout = expectStatus(await api(pendingPhone.checkoutPath, { token: client.token }), 200, "Owner can inspect checkout");
    assert.equal(ownerCheckout.order.trackingCode, pendingPhone.trackingCode);
    assert.equal(ownerCheckout.consultation.id, pendingPhone.id);

    const paymentAttempts = await Promise.all([
      api(`${pendingPhone.checkoutPath}/pay`, { method: "POST", token: client.token }),
      api(`${pendingPhone.checkoutPath}/pay`, { method: "POST", token: client.token }),
    ]);
    const payments = paymentAttempts.map((response, index) => expectStatus(response, 200, `Idempotent payment attempt ${index + 1}`));
    assert.equal(payments.filter((payment) => payment.idempotent === false).length, 1);
    assert.equal(payments.filter((payment) => payment.idempotent === true).length, 1);
    for (const payment of payments) {
      assert.equal(payment.order.status, "paid");
      assert.equal(payment.consultation.paymentStatus, "simulated_paid");
      assert.equal(payment.consultation.status, "pending_coordination");
      assert.ok(payment.order.paidAt);
    }
    expectStatus(await api(`${pendingPhone.checkoutPath}/cancel`, {
      method: "POST",
      token: client.token,
    }), 409, "Paid checkout cannot be cancelled through pending checkout route");

    const phoneConsultation = expectStatus(await api("/api/consultations", {
      method: "POST",
      token: client.token,
      body: {
        type: "phone",
        topic: "Review a commercial agreement",
        scheduledAt,
        amount: 1,
      },
    }), 201, "Create phone consultation");
    assert.equal(phoneConsultation.amount, Number(bootstrap.settings.default_phone_price));
    assert.notEqual(phoneConsultation.amount, 1);
    assert.equal(phoneConsultation.paymentStatus, "simulated_paid");
    assert.equal(phoneConsultation.status, "pending_coordination");
    assert.equal(phoneConsultation.scheduledAt, null);
    assert.equal(phoneConsultation.lawyerId, null);
    const phoneAttachment = expectStatus(await upload("/api/documents", client.token, "consultation", null, phoneConsultation.id), 201, "Attach a file while booking a phone consultation");

    const afterPhone = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Client orders after phone checkout");
    const phoneOrder = afterPhone.orders.find((item) => item.consultation_id === phoneConsultation.id);
    const phoneInDashboard = afterPhone.consultations.find((item) => item.id === phoneConsultation.id);
    assert.ok(phoneOrder);
    assert.equal(phoneOrder.amount, Number(bootstrap.settings.default_phone_price));
    assert.equal(phoneOrder.status, "paid");
    assert.ok(phoneInDashboard.attachments.some((item) => item.id === phoneAttachment.document.id));
    assert.ok(!afterPhone.conversations.some((item) => item.consultation_id === phoneConsultation.id), "Phone consultation does not open a chat");
    assert.ok(!afterPhone.documents.some((item) => item.id === phoneAttachment.document.id), "Phone attachment stays out of general documents");

    const paidText = expectStatus(await api("/api/consultations", {
      method: "POST",
      token: client.token,
      body: {
        type: "text",
        topic: "A paid text continuation",
        lawyerId,
        amount: 500000,
        sourceQuestionId: questionCreated.id,
      },
    }), 201, "Create paid text consultation");
    assert.equal(paidText.status, "confirmed");

    const slot = publicLawyer.available_slots?.find((item) => item.consultation_type === "in_person");
    assert.ok(slot, "Seed data must expose a future in-person slot for the test lawyer");
    const inPersonPayload = {
      type: "in_person",
      topic: "In-person document review",
      lawyerId,
      slotId: slot.id,
      scheduledAt: slot.starts_at,
    };
    const heldInPerson = expectStatus(await api("/api/consultations", {
      method: "POST",
      token: client.token,
      body: { ...inPersonPayload, topic: "Hold this slot until checkout", deferPayment: true },
    }), 201, "Hold an in-person slot for pending checkout");
    assert.equal(heldInPerson.status, "pending_payment");
    expectStatus(await api("/api/consultations", {
      method: "POST",
      token: client.token,
      body: inPersonPayload,
    }), 409, "Pending checkout prevents another booking of its slot");
    const cancelledCheckout = expectStatus(await api(`/api/checkout/${heldInPerson.trackingCode}/cancel`, {
      method: "POST",
      token: client.token,
    }), 200, "Cancel pending in-person checkout");
    assert.equal(cancelledCheckout.order.status, "cancelled");
    assert.equal(cancelledCheckout.consultation.status, "cancelled");
    assert.equal(cancelledCheckout.consultation.paymentStatus, "cancelled");
    const cancelledAgain = expectStatus(await api(`/api/checkout/${heldInPerson.trackingCode}/cancel`, {
      method: "POST",
      token: client.token,
    }), 200, "Repeat pending checkout cancellation safely");
    assert.equal(cancelledAgain.idempotent, true);

    const inPerson = expectStatus(await api("/api/consultations", {
      method: "POST",
      token: client.token,
      body: inPersonPayload,
    }), 201, "Book an in-person slot");
    assert.ok(Number.isSafeInteger(inPerson.id));
    expectStatus(await api("/api/consultations", {
      method: "POST",
      token: client.token,
      body: inPersonPayload,
    }), 409, "Prevent double booking");

    const phoneSlot = expectStatus(await api("/api/lawyer/action", {
      method: "POST",
      token: lawyer.token,
      body: { action: "add-slot", consultationType: "phone", startsAt: new Date(Date.now() + 60 * 86400000).toISOString() },
    }), 201, "Lawyer adds private phone availability");
    const accepted = expectStatus(await api("/api/admin/action", {
      method: "POST", token: admin.token,
      body: { action: "schedule-phone", id: phoneConsultation.id, slotId: phoneSlot.id },
    }), 200, "Support coordinates the phone consultation");
    assert.equal(accepted.consultation?.status, "confirmed");
    const scheduledDashboard = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Scheduled consultation dashboard");
    assert.ok(!scheduledDashboard.conversations.some((item) => item.consultation_id === phoneConsultation.id), "Scheduled phone consultation still has no chat");
    const lawyerPhoneDashboard = expectStatus(await api("/api/dashboard", { token: lawyer.token }), 200, "Lawyer sees the scheduled phone request");
    const lawyerPhoneConsultation = lawyerPhoneDashboard.consultations.find((item) => item.id === phoneConsultation.id);
    assert.ok(lawyerPhoneConsultation?.attachments.some((item) => item.id === phoneAttachment.document.id), "Lawyer sees the booking attachment on the phone request");
    assert.ok(!lawyerPhoneDashboard.documents.some((item) => item.id === phoneAttachment.document.id), "Phone attachment stays out of lawyer general documents");
    assert.ok(!lawyerPhoneDashboard.conversations.some((item) => item.consultation_id === phoneConsultation.id), "Lawyer dashboard has no phone chat");
    assert.equal((await fetch(`${baseUrl}/api/documents/${phoneAttachment.document.id}/download`, { headers: { Authorization: `Bearer ${lawyer.token}` } })).status, 200);
    expectStatus(await api("/api/chat/messages", {
      method: "POST",
      token: client.token,
      body: { consultationId: phoneConsultation.id, body: "A phone booking must not create a text room." },
    }), 404, "Phone consultation cannot receive chat messages");

    const started = expectStatus(await api("/api/consultation/action", {
      method: "POST",
      token: lawyer.token,
      body: { consultationId: phoneConsultation.id, action: "start" },
    }), 200, "Start consultation");
    assert.equal(started.consultation?.status, "in_progress");
    assert.equal(started.conversation, null);

    const completed = expectStatus(await api("/api/consultation/action", {
      method: "POST",
      token: lawyer.token,
      body: { consultationId: phoneConsultation.id, action: "complete" },
    }), 200, "Complete consultation");
    assert.equal(completed.consultation?.status, "completed");
    assert.equal(completed.conversation, null);

    const reviewableDashboard = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Review eligibility dashboard");
    assert.ok(reviewableDashboard.eligibleReviews.some((item) => item.consultation_id === phoneConsultation.id));
    const reviewPayload = {
      consultationId: phoneConsultation.id,
      lawyerId,
      type: "phone",
      rating: 5,
      body: "The consultation was clear, practical, and professionally handled.",
    };
    const review = expectStatus(await api("/api/reviews", {
      method: "POST",
      token: client.token,
      body: reviewPayload,
    }), 201, "Create consultation review");
    assert.ok(Number.isSafeInteger(review.id));
    expectStatus(await api("/api/reviews", {
      method: "POST",
      token: client.token,
      body: reviewPayload,
    }), 409, "Prevent duplicate review");

    const supportRequest = expectStatus(await api("/api/messages", {
      method: "POST",
      token: client.token,
      body: {
        name: "API Test Client",
        phone: "09120000000",
        kind: "support",
        subject: "Consultation follow-up",
        body: "Please confirm that the completed consultation is visible in my account.",
        orderCode: phoneConsultation.trackingCode,
      },
    }), 201, "Create support request");
    assert.ok(Number.isSafeInteger(supportRequest.id));

    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: {
        action: "create-admin",
        username: "support_admin_test",
        password: "Support123!",
        firstName: "Support",
        lastName: "Operator",
        email: "support-admin-test@dadrah.local",
        phone: "02191090000",
        permissions: ["support.manage"],
      },
    }), 201, "Create limited admin");

    const limitedAdmin = await login(api, "support_admin_test", "Support123!", "admin");
    const limitedDashboard = expectStatus(await api("/api/dashboard", { token: limitedAdmin.token }), 200, "Limited admin dashboard");
    assert.equal(limitedDashboard.isPrimaryAdmin, false);
    assert.deepEqual(limitedDashboard.capabilities, ["support.manage"]);
    assert.ok(Array.isArray(limitedDashboard.messages));
    assert.equal(Object.hasOwn(limitedDashboard, "settings"), false);
    assert.equal(Object.hasOwn(limitedDashboard, "users"), false);

    const supportReply = "Your completed consultation and its receipt are available in the client dashboard.";
    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: limitedAdmin.token,
      body: { action: "message-update", messageId: supportRequest.id, status: "answered", reply: supportReply },
    }), 200, "Limited admin replies to support request");

    const supportVisible = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Client sees support reply");
    const repliedMessage = supportVisible.messages.find((item) => item.id === supportRequest.id);
    assert.ok(repliedMessage);
    assert.equal(repliedMessage.status, "answered");
    assert.equal(repliedMessage.admin_reply, supportReply);

    expectStatus(await api("/api/admin/stats", { token: limitedAdmin.token }), 403, "Limited admin cannot view reports");
    expectStatus(await api("/api/articles", {
      method: "POST",
      token: limitedAdmin.token,
      body: {
        slug: "permission-escalation-test",
        title: "Permission escalation test",
        excerpt: "This article must not be created by a support-only administrator.",
        body: "This body is deliberately long enough for validation but must be rejected by authorization.",
        category: "Security",
        publish: true,
      },
    }), 403, "Limited admin cannot manage articles");
    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: limitedAdmin.token,
      body: { action: "setting", key: "site_name", value: "Unauthorized change" },
    }), 403, "Limited admin cannot change settings");
    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: limitedAdmin.token,
      body: { action: "setting", key: "primary_admin_id", value: String(limitedAdmin.user.id) },
    }), 403, "Limited admin cannot replace the primary admin");

    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: { action: "setting", key: "primary_admin_id", value: String(limitedAdmin.user.id) },
    }), 400, "Primary admin identifier is not a mutable setting");
    expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: {
        action: "set-admin-permission",
        adminId: admin.user.id,
        permission: "admins.manage",
        enabled: false,
      },
    }), 403, "Primary admin permissions cannot be limited");

    const primaryAfterEscalationAttempts = expectStatus(await api("/api/dashboard", { token: admin.token }), 200, "Primary admin remains primary");
    assert.equal(primaryAfterEscalationAttempts.isPrimaryAdmin, true);
    assert.ok(primaryAfterEscalationAttempts.capabilities.includes("admins.manage"));
    const limitedAfterEscalationAttempts = expectStatus(await api("/api/dashboard", { token: limitedAdmin.token }), 200, "Limited admin remains limited");
    assert.equal(limitedAfterEscalationAttempts.isPrimaryAdmin, false);
    assert.deepEqual(limitedAfterEscalationAttempts.capabilities, ["support.manage"]);

    expectStatus(await api("/api/auth/login", { method: "POST", body: { username: "lawyer", password: "Lawyer123!", expectedRole: "client" } }), 403, "Reject login through the wrong role");
    const forgot = expectStatus(await api("/api/auth/forgot-password", { method: "POST", body: { phone: "09123456789" } }), 200, "Password recovery is ready for SMS integration");
    assert.equal(forgot.smsEnabled, false);
    expectStatus(await api("/api/auth/register", { method: "POST", body: { username: "no-mobile", password: "Client123!", firstName: "Test", lastName: "User", email: "nomobile@example.test", phone: "" } }), 400, "Registration requires a mobile number");

    expectStatus(await api("/api/questions", { method: "POST", token: client.token, body: { topic: "Third question", body: "This is the third allowed free legal question for this client." } }), 201, "Third free question is allowed");
    expectStatus(await api("/api/questions", { method: "POST", token: client.token, body: { topic: "Fourth question", body: "This free legal question must exceed the account lifetime quota." } }), 409, "Fourth free question exceeds the quota");
    expectStatus(await api("/api/admin/action", { method: "POST", token: admin.token, body: { action: "assign-question", questionId: directQuestion.id, lawyerIds: bootstrap.lawyers.slice(0, 4).map((item) => item.id) } }), 400, "Assignment respects the configured lawyer limit");

    const firstClientTurn = expectStatus(await api("/api/chat/messages", { method: "POST", token: client.token, body: { consultationId: paidText.id, body: "Client first turn, message one" } }), 201, "Client starts the first paid text turn");
    const conversationId = firstClientTurn.message.conversation_id;
    assert.deepEqual(firstClientTurn.turn_usage, { client: 1, lawyer: 0 });
    const sameClientTurn = expectStatus(await api("/api/chat/messages", { method: "POST", token: client.token, body: { conversationId, body: "Client first turn, consecutive message two" } }), 201, "Consecutive client message stays in one turn");
    assert.deepEqual(sameClientTurn.turn_usage, { client: 1, lawyer: 0 });
    const firstLawyerTurn = expectStatus(await api("/api/chat/messages", { method: "POST", token: lawyer.token, body: { conversationId, body: "Lawyer first turn, message one" } }), 201, "Lawyer starts the first paid text turn");
    assert.deepEqual(firstLawyerTurn.turn_usage, { client: 1, lawyer: 1 });
    const sameLawyerTurn = expectStatus(await api("/api/chat/messages", { method: "POST", token: lawyer.token, body: { conversationId, body: "Lawyer first turn, consecutive message two" } }), 201, "Consecutive lawyer message stays in one turn");
    assert.deepEqual(sameLawyerTurn.turn_usage, { client: 1, lawyer: 1 });
    expectStatus(await api("/api/chat/messages", { method: "POST", token: client.token, body: { conversationId, body: "Client second turn" } }), 201, "Client starts second turn");
    expectStatus(await api("/api/chat/messages", { method: "POST", token: lawyer.token, body: { conversationId, body: "Lawyer second turn" } }), 201, "Lawyer starts second turn");
    expectStatus(await api("/api/chat/messages", { method: "POST", token: client.token, body: { conversationId, body: "Client third and final turn" } }), 201, "Client starts final turn");
    const finalLawyerTurn = expectStatus(await api("/api/chat/messages", { method: "POST", token: lawyer.token, body: { conversationId, body: "Lawyer third and final turn" } }), 201, "Lawyer starts final turn and closes the room");
    assert.deepEqual(finalLawyerTurn.turn_usage, { client: 3, lawyer: 3 });
    assert.equal(finalLawyerTurn.conversation_status, "closed");
    assert.equal(finalLawyerTurn.quota_complete, true);
    expectStatus(await api("/api/chat/messages", { method: "POST", token: client.token, body: { conversationId, body: "A fourth client turn must be rejected" } }), 409, "Client cannot exceed paid turn allowance");
    const afterText = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Dashboard after paid text allowance");
    assert.equal(afterText.consultations.find((item) => item.id === paidText.id).status, "completed");
    assert.equal(afterText.conversations.find((item) => item.consultation_id === paidText.id).status, "closed");
    expectStatus(await api("/api/profile", { method: "POST", token: lawyer.token, body: { phonePrice: 1 } }), 400, "Lawyer cannot price below the administrator range");

    const avatar = expectStatus(await upload("/api/avatar", client.token), 201, "Upload client avatar");
    assert.equal((await fetch(`${baseUrl}${avatar.url}`)).status, 200);
    expectStatus(await upload("/api/documents", lawyer.token, "avatar"), 400, "Private document upload cannot mint public media kinds");
    const document = expectStatus(await upload("/api/documents", client.token, "general", questionCreated.id), 201, "Attach a private question document");
    assert.equal(document.document.status, "approved");
    assert.equal((await fetch(`${baseUrl}/api/documents/${document.document.id}/download`, { headers: { Authorization: `Bearer ${lawyer.token}` } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/media/${document.document.id}`)).status, 404);

    const attachment = expectStatus(await upload("/api/documents", client.token, "consultation", null, paidText.id), 201, "Attach a document to the paid conversation");
    const clientWithAttachments = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Client sees conversation attachments");
    const lawyerWithAttachments = expectStatus(await api("/api/dashboard", { token: lawyer.token }), 200, "Lawyer sees conversation attachments");
    const adminWithTracking = expectStatus(await api("/api/dashboard", { token: admin.token }), 200, "Admin sees consultation tracking code");
    for (const dashboard of [clientWithAttachments, lawyerWithAttachments]) {
      assert.ok(dashboard.documents.every((item) => item.consultation_id === null && item.question_id === null), "Chat attachments stay out of the general document list");
      const dashboardQuestion = dashboard.questions.find((item) => item.id === questionCreated.id);
      assert.ok(dashboardQuestion?.attachments.some((item) => item.id === document.document.id), "Question attachments must be available inside the chat thread");
      const conversation = dashboard.conversations.find((item) => item.consultation_id === paidText.id);
      assert.equal(conversation.attachments.length, 2);
      assert.ok(conversation.attachments.some((item) => item.id === attachment.document.id));
      assert.ok(conversation.attachments.some((item) => item.id === document.document.id), "Paid continuation includes the source question's permitted documents");
      assert.equal(Object.hasOwn(conversation.attachments[0], "path"), false);
      assert.equal(conversation.tracking_code, paidText.trackingCode);
      assert.equal(conversation.message_limit, 3);
      assert.equal(conversation.lawyer_id, lawyerId);
      assert.equal(conversation.consultation.type, "text");
      assert.equal(conversation.consultation.source_question_id, questionCreated.id);
      assert.equal(conversation.client_avatar_url, avatar.url);
      assert.ok(conversation.lawyer_avatar_url);
      assert.ok(conversation.messages.every((item) => typeof item.sender_avatar_url === "string"));
    }
    for (const dashboard of [clientWithAttachments, lawyerWithAttachments, adminWithTracking]) assert.equal(dashboard.consultations.find((item) => item.id === paidText.id).tracking_code, paidText.trackingCode);
    assert.equal((await fetch(`${baseUrl}/api/documents/${attachment.document.id}/download`, { headers: { Authorization: `Bearer ${lawyer.token}` } })).status, 200);
    const outsider = await login(api, "client", "Client123!", "client");
    assert.equal((await fetch(`${baseUrl}/api/documents/${attachment.document.id}/download`, { headers: { Authorization: `Bearer ${outsider.token}` } })).status, 404);
    expectStatus(await upload("/api/documents", outsider.token, "consultation", null, paidText.id), 403, "A nonparticipant cannot attach documents to another conversation");
    assert.ok(!expectStatus(await api("/api/dashboard", { token: outsider.token }), 200, "Nonparticipant dashboard").conversations.some((item) => item.consultation_id === paidText.id));

    const cover = expectStatus(await upload("/api/article-cover", lawyer.token), 201, "Upload article cover");
    const tag = JSON.parse(bootstrap.settings.article_tags)[0];
    const articlePayload = { slug: "lawyer-workflow-article", title: "A helpful legal article", excerpt: "A concise summary for the article.", body: "This is a complete article drafted by a lawyer for editorial review.", tags: [tag], coverImage: cover.url, publish: true };
    const draft = expectStatus(await api("/api/articles", { method: "POST", token: lawyer.token, body: articlePayload }), 200, "Lawyer submits article for approval");
    assert.equal(draft.status, "pending_review");
    const beforePublish = expectStatus(await api("/api/bootstrap"), 200, "Public articles exclude pending drafts");
    assert.ok(!beforePublish.articles.some((item) => item.slug === articlePayload.slug));
    const editorial = expectStatus(await api("/api/dashboard", { token: admin.token }), 200, "Administrator receives draft article");
    const article = editorial.articles.find((item) => item.slug === articlePayload.slug);
    assert.ok(article);
    assert.equal(article.category, tag, "Category is derived from the first selected tag");
    expectStatus(await api("/api/admin/action", { method: "POST", token: admin.token, body: { action: "publish-article", id: article.id } }), 200, "Administrator approves publication");
    assert.ok(expectStatus(await api("/api/bootstrap"), 200, "Published article appears publicly").articles.some((item) => item.id === article.id && item.cover_image === cover.url));
    expectStatus(await api("/api/articles", { method: "POST", token: lawyer.token, body: { ...articlePayload, id: bootstrap.articles[0].id } }), 403, "Lawyer cannot edit another author's article");
    expectStatus(await api("/api/articles", { method: "POST", token: admin.token, body: { ...articlePayload, slug: "untagged-workflow-article", tags: [] } }), 400, "Article requires at least one administrator-defined tag");
    expectStatus(await api("/api/articles", { method: "POST", token: admin.token, body: { ...articlePayload, slug: "invalid-tag-workflow-article", tags: ["not-an-approved-tag"] } }), 400, "Article cannot introduce unapproved tags");

    const incompleteSpecialtyIds = [customSpecialty.id, bootstrap.services[0].id];
    expectStatus(await api("/api/auth/register", { method: "POST", body: { username: "incomplete-lawyer", password: "Lawyer123!", firstName: "New", lastName: "Lawyer", phone: "09129876543", email: "new-lawyer@example.test", role: "lawyer", licenseNumber: "TEST-9898", specialtyIds: incompleteSpecialtyIds } }), 201, "Register a lawyer with multiple administrator-defined specialties");
    const incompleteLawyer = await login(api, "incomplete-lawyer", "Lawyer123!", "lawyer");
    const incompleteDashboard = expectStatus(await api("/api/dashboard", { token: incompleteLawyer.token }), 200, "Incomplete lawyer dashboard");
    assert.equal(incompleteDashboard.profile.profile_completed, 0);
    assert.equal(incompleteDashboard.documents.length, 0);
    assert.deepEqual([...incompleteDashboard.profile.specialty_ids].sort((a, b) => a - b), [...incompleteSpecialtyIds].sort((a, b) => a - b));
    assert.ok(incompleteDashboard.services.some((item) => item.id === customSpecialty.id && item.selected === 1));
    expectStatus(await api("/api/admin/action", { method: "POST", token: admin.token, body: { action: "service-delete", id: customSpecialty.id } }), 409, "A linked specialty cannot be deleted");
    expectStatus(await api("/api/admin/action", { method: "POST", token: limitedAdmin.token, body: { action: "verify-lawyer", id: incompleteDashboard.profile.id, approved: true } }), 403, "Verification still requires administrator permission");
    assert.equal(expectStatus(await api("/api/admin/action", { method: "POST", token: admin.token, body: { action: "verify-lawyer", id: incompleteDashboard.profile.id, approved: true } }), 200, "Administrator can approve an incomplete lawyer").verified, true);
    assert.equal(expectStatus(await api("/api/admin/action", { method: "POST", token: admin.token, body: { action: "verify-lawyer", id: incompleteDashboard.profile.id, approved: false } }), 200, "Administrator can reject an incomplete lawyer").verified, false);

    const notifications = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Client notifications");
    const answerNotification = notifications.notificationItems.find((item) => item.id === `answer-${answered.id}`);
    assert.ok(answerNotification);
    expectStatus(await api("/api/notifications/read", { method: "POST", token: client.token, body: { ids: [answerNotification.id] } }), 200, "Mark notification read");
    assert.ok(!expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Read state persists").notificationItems.some((item) => item.id === answerNotification.id));
    expectStatus(await api("/api/admin/action", { method: "POST", token: admin.token, body: { action: "setting", key: "stats_enabled", value: "0" } }), 200, "Administrator controls statistics display");
    const beforeVisit = expectStatus(await api("/api/bootstrap"), 200, "Statistics before visit");
    expectStatus(await api("/api/visit", { method: "POST" }), 200, "Record public site visit");
    const afterVisit = expectStatus(await api("/api/bootstrap"), 200, "Statistics after visit");
    assert.equal(afterVisit.stats.views, beforeVisit.stats.views + 1);
    assert.equal(afterVisit.settings.stats_enabled, "0");
    assert.ok(afterVisit.lawyers.every((item) => item.available_slots.every((item) => item.consultation_type === "in_person")));
  } finally {
    await stopApi(apiProcess);
    if (testCwd && testCwd.startsWith(join(tmpdir(), "dadrah-api-test-"))) rmSync(testCwd, { recursive: true, force: true });
  }
});
