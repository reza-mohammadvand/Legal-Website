import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const cwd = fileURLToPath(root);

function resetDatabase() {
  const result = spawnSync(process.execPath, ["server/reset-db.mjs"], {
    cwd,
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
  const child = spawn(process.execPath, ["server/local-api.mjs"], {
    cwd,
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
    body: { username, password },
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

  resetDatabase();
  try {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    ({ child: apiProcess, output: processOutput } = startApi(port));
    await waitForApi(baseUrl, apiProcess, processOutput);
    const api = apiClient(baseUrl);

    const health = expectStatus(await api("/api/health"), 200, "Health check");
    assert.equal(health.ok, true);
    assert.equal(typeof health.database, "string");

    const bootstrap = expectStatus(await api("/api/bootstrap"), 200, "Public bootstrap");
    for (const collection of ["lawyers", "articles", "questions", "services", "faqs", "reviews"]) {
      assert.ok(Array.isArray(bootstrap[collection]), `bootstrap.${collection} must be an array`);
    }
    assert.ok(bootstrap.lawyers.length >= 1);
    assert.equal(typeof bootstrap.settings, "object");

    expectStatus(await api("/api/dashboard"), 401, "Anonymous dashboard request");
    expectStatus(await api("/api/questions", {
      method: "POST",
      body: { topic: "Unauthorized", body: "This question must not be accepted without a session." },
    }), 401, "Anonymous question request");

    const client = await login(api, "client", "Client123!", "client");
    const lawyer = await login(api, "lawyer", "Lawyer123!", "lawyer");
    const admin = await login(api, "admin", "Admin123!", "admin");

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
    assert.equal(questionCreated.status, "pending_assignment");
    assert.ok(Number.isSafeInteger(questionCreated.id));

    const assignment = expectStatus(await api("/api/admin/action", {
      method: "POST",
      token: admin.token,
      body: { action: "assign-question", questionId: questionCreated.id, lawyerIds: [lawyerId] },
    }), 200, "Assign question");
    assert.deepEqual(assignment.assigned, [lawyerId]);

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
    assert.equal(answeredQuestion.status, "answered");
    assert.ok(Array.isArray(answeredQuestion.answers));
    assert.equal(answeredQuestion.answers.length, 1);
    assert.equal(answeredQuestion.answers[0].id, answered.id);

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
      assert.equal(payment.consultation.status, "registered");
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
        lawyerId,
        scheduledAt,
        amount: 1,
      },
    }), 201, "Create phone consultation");
    assert.equal(phoneConsultation.amount, publicLawyer.phone_price);
    assert.notEqual(phoneConsultation.amount, 1);
    assert.equal(phoneConsultation.paymentStatus, "simulated_paid");
    assert.equal(phoneConsultation.status, "registered");

    const afterPhone = expectStatus(await api("/api/dashboard", { token: client.token }), 200, "Client orders after phone checkout");
    const phoneOrder = afterPhone.orders.find((item) => item.consultation_id === phoneConsultation.id);
    assert.ok(phoneOrder);
    assert.equal(phoneOrder.amount, publicLawyer.phone_price);
    assert.equal(phoneOrder.status, "paid");

    expectStatus(await api("/api/consultations", {
      method: "POST",
      token: client.token,
      body: {
        type: "text",
        topic: "A paid text consultation must be rejected",
        lawyerId,
        amount: 500000,
      },
    }), 400, "Reject paid text consultation");

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

    const accepted = expectStatus(await api("/api/consultation/action", {
      method: "POST",
      token: lawyer.token,
      body: { consultationId: phoneConsultation.id, action: "accept" },
    }), 200, "Accept consultation");
    assert.equal(accepted.consultation?.status, "confirmed");
    assert.ok(Number.isSafeInteger(accepted.conversation?.id));
    const conversationId = accepted.conversation.id;

    const clientChat = expectStatus(await api("/api/chat/messages", {
      method: "POST",
      token: client.token,
      body: { conversationId, body: "I have prepared the documents for our scheduled consultation." },
    }), 201, "Client sends consultation message");
    assert.equal(clientChat.message?.conversation_id, conversationId);
    assert.equal(clientChat.message?.sender_id, client.user.id);

    const started = expectStatus(await api("/api/consultation/action", {
      method: "POST",
      token: lawyer.token,
      body: { consultationId: phoneConsultation.id, action: "start" },
    }), 200, "Start consultation");
    assert.equal(started.consultation?.status, "in_progress");

    const lawyerChat = expectStatus(await api("/api/chat/messages", {
      method: "POST",
      token: lawyer.token,
      body: { consultationId: phoneConsultation.id, body: "The documents are received and the consultation is now in progress." },
    }), 201, "Lawyer sends consultation message");
    assert.equal(lawyerChat.message?.conversation_id, conversationId);
    assert.equal(lawyerChat.message?.sender_id, lawyer.user.id);

    const completed = expectStatus(await api("/api/consultation/action", {
      method: "POST",
      token: lawyer.token,
      body: { consultationId: phoneConsultation.id, action: "complete" },
    }), 200, "Complete consultation");
    assert.equal(completed.consultation?.status, "completed");
    assert.equal(completed.conversation?.status, "closed");

    expectStatus(await api("/api/chat/messages", {
      method: "POST",
      token: client.token,
      body: { conversationId, body: "A closed consultation must not accept another message." },
    }), 409, "Reject message after completion");

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
  } finally {
    await stopApi(apiProcess);
    resetDatabase();
  }
});
