# Dadrah Project Architecture and Engineering Mindset

> This is the single-reference document for understanding the project. Sections describing the current state are derived from the code. Sections labeled as mindset, risks, or recommendations are architectural analysis and should not be treated as undocumented decisions made by the original author.

## 1. Executive Summary

Dadrah is a Persian, right-to-left legal-services platform that connects clients with lawyers. The product supports four primary journeys:

1. Submit a free legal question and receive answers from relevant lawyers.
2. Purchase a text consultation with a defined message-turn allowance.
3. Book a phone consultation.
4. Book an in-person consultation in a lawyer's available time slot.

In addition to the public website, the application provides dedicated dashboards for clients, lawyers, and administrators. It also includes article publishing, legal specialties, question assignment, consultations, documents, chat, reviews, simulated payments, support requests, public settings, and delegated administrator permissions.

The current architecture is intentionally optimized for a complete local demo with minimal infrastructure:

- UI: React 19 with Next/Vinext and a large client-side application shell.
- API: a native Node.js HTTP server without a web framework.
- Data: Node's built-in SQLite support, with WAL and foreign keys enabled.
- Data model: Drizzle schema plus an SQL migration.
- Experimental frontend deployment: Cloudflare/Vinext.
- Application authentication: a custom Bearer-token session system.
- Tests: Node's test runner, rendered-HTML checks, structural contracts, and an end-to-end API workflow.

## 2. Product Mindset

The most useful mental model for the codebase is:

```text
Anonymous visitor
  ├─ Browses public content, lawyers, questions, and articles
  └─ Authenticates when beginning a protected action

Client
  ├─ Submits a free legal question
  ├─ Books a paid consultation
  ├─ Uploads documents
  ├─ Participates in text consultations
  └─ Reviews a lawyer after a completed consultation

Lawyer
  ├─ Completes a professional profile and selects specialties
  ├─ Creates appointment availability
  ├─ Answers assigned questions
  ├─ Manages consultations and chat
  └─ Submits articles for administrative review

Administrator
  ├─ Verifies lawyers and moderates public content
  ├─ Assigns questions and manages consultations
  ├─ Reviews documents, support, reviews, and payments
  └─ Controls settings, delegated administrators, and public branding
```

### Principles inferred from the code

- **Trust before conversion:** lawyer verification, privacy, status visibility, and tracking codes are prominent throughout the experience.
- **One action, one workflow:** questions, consultations, orders, files, and conversations have separate entities and lifecycles.
- **Server-side authority:** prices, quotas, document access, answer limits, and state changes are enforced by the API rather than trusted to the UI.
- **Configuration over hardcoding:** copy, limits, price ranges, public media, and feature availability are largely stored in `settings`.
- **A complete demo without external services:** SQLite, simulated payments, and seed data make the entire workflow locally runnable.
- **Progressive authentication:** users can begin a flow before signing in; the serializable draft is stored in session storage and restored after authentication.

## 3. Architecture Map

```text
Browser / React UI :3010
        │
        │ JSON + Bearer token + multipart upload
        ▼
Node HTTP API :8787
        │
        ├─ validation / authorization / workflow rules
        ├─ file storage → data/uploads
        └─ SQLite → data/dadrah.sqlite

Vinext build
  └─ Cloudflare Worker entry → worker/index.ts
```

### Responsibility boundaries

| Layer | Main files | Responsibility |
|---|---|---|
| Next/Vinext shell | `app/layout.tsx`, `app/page.tsx`, `app/[...path]/page.tsx` | Metadata, RTL document setup, app entry, and deep links |
| Product UI | `app/dadrah-app.tsx` | Public pages, modals, dashboards, API calls, and client state |
| Display data | `app/dadrah-data.ts` | UI types and public fallback/seed data |
| Styling | `app/globals.css` | Tokens, layouts, responsiveness, dark mode, and motion |
| API | `server/local-api.mjs` | Routing, validation, authorization, and domain workflows |
| Runtime database | `server/db.mjs` | Schema installation/upgrades, seeding, sessions, and password hashing |
| Schema reference | `db/schema.ts` | Drizzle definitions for 20 tables and their constraints |
| Migration | `drizzle/0000_dadrah_core.sql` | SQL schema migration |
| Development runner | `scripts/dev-local.mjs` | Starts the API and web processes together |
| Schema validation | `scripts/check-schema.mjs` | Validates the migration |
| Data reset | `server/reset-db.mjs` | Rebuilds local data and test uploads |
| Frontend deployment | `vite.config.ts`, `worker/index.ts` | Vinext, Cloudflare bindings, and image optimization |
| Tests | `tests/*.mjs` | Rendered HTML, architecture contracts, and API workflows |

## 4. Running the Project

### Requirements

- Node.js `22.13.0` or newer
- npm
- No separate database server; the project uses `node:sqlite`.

### Install and run

```powershell
npm ci
npm run dev
```

Local endpoints:

- Website: `http://localhost:3010`
- API: `http://localhost:8787`
- API health: `http://localhost:8787/api/health`

`npm run dev` launches two child processes: `server/local-api.mjs` and Vinext on port 3010. Stopping the parent process stops both children.

### Important commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start web and API together |
| `npm run dev:web` | Start only the frontend |
| `npm run dev:api` | Start only the API |
| `npm run build` | Create a production frontend build |
| `npm start` | Run the production build |
| `npm test` | Build and run every test |
| `npm run test:api` | Run only the API workflow test |
| `npm run lint` | Run ESLint |
| `npm run db:generate` | Generate a migration from the Drizzle schema |
| `npm run db:check` | Validate the migration and expected table count |
| `npm run db:reset` | Reset local data and seed it again |

## 5. Frontend Routing

Public routing is centralized in two functions inside `dadrah-app.tsx`:

- `routeFor(path)` converts a browser URL into the internal `Route` model.
- `pathFor(route)` converts that model back into a URL.

Next supplies the homepage and a catch-all entry point, but the actual page selection is driven by application state. Important routes include:

| Route | Purpose |
|---|---|
| `/` | Homepage |
| `/lawyers` | Lawyer directory and specialty filtering |
| `/lawyers/:id` | Lawyer profile |
| `/questions` | Public legal questions |
| `/questions/:id` | Question details and published answers |
| `/blog` | Legal magazine |
| `/blog/:slug` | Article page |
| `/dashboard` | Dashboard for the active role |
| `/ask` | Begin a legal request |
| `/auth/login`, `/auth/register` | Authentication entry points |
| Static pages | About, contact, terms, and privacy |

This approach keeps the demo fast and cohesive, but `dadrah-app.tsx` has become very large. Long-term development should split routes and dashboard domains into dedicated modules.

## 6. Client State and API Communication

The central `request()` helper sends requests to `http://localhost:8787/api`. Authenticated requests include:

```http
Authorization: Bearer <token>
```

On mount, the application loads public content from `/api/bootstrap`. If the API is unavailable, public pages continue to render with fallback data from `dadrah-data.ts`, while the UI displays a warning to run `npm run dev`.

Important root state includes:

- current route;
- authenticated session and role;
- active modal or workflow;
- public lawyers, questions, services, articles, reviews, FAQs, and settings;
- bookmarks;
- backend availability;
- toast notifications;
- mobile menu state.

Dark mode is persisted in `localStorage` under `dadrah-theme`. A pending authentication flow is kept in `sessionStorage`. File objects are intentionally removed from the saved draft because they are not safely serializable.

## 7. Main UI Areas

### Public interface

- `SiteHeader`, `Brand`, and `SiteFooter`
- `HomePage`
- `LawyersPage` and `LawyerProfile`
- `QuestionsPage` and `QuestionDetail`
- `BlogPage` and `ArticlePage`
- About, Contact, Reviews, Terms, and Privacy pages
- `PublicStats`, `TrustItems`, and `SectionTitle`
- specialty, consultation method, lawyer, question, and article cards

### Flows and modals

- `AuthModal`: role-aware sign-in and registration
- `IntakeModal`: free-question intake or service selection
- `ConsultModal`: text, phone, and in-person consultation booking
- `ReviewModal`: review submission after a consultation
- `FlowHeader` and `ModalShell`: reusable multi-step flow primitives

### Dashboards

- `Dashboard`: shared role-aware shell
- `ClientPanel`: requests, consultations, chat, documents, bookmarks, and support
- `LawyerPanel`: assigned questions, consultations, calendar, chat, articles, reviews, and profile
- `AdminPanel`: users, lawyers, assignments, consultations, content, services, reviews, documents, support, finance, reports, settings, and administrators

Reusable dashboard primitives include `DashboardCard`, `Metric`, `DataTable`, `Status`, `Empty`, `CalendarPanel`, `ChatPanel`, `UploadPanel`, and `ProfilePanel`.

## 8. Data Model

The SQLite database contains 20 tables:

| Table | Responsibility |
|---|---|
| `users` | Client, lawyer, and administrator accounts |
| `lawyers` | Professional details, prices, verification, availability, and rating |
| `questions` | Free questions and legal intake records |
| `question_assignments` | Many-to-many assignment of questions to lawyers |
| `answers` | Lawyer answers to questions |
| `appointment_slots` | Available or booked lawyer time slots |
| `consultations` | Text, phone, and in-person consultations |
| `orders` | Charges, commissions, payment, and refunds |
| `reviews` | Consultation-linked lawyer ratings and reviews |
| `bookmarks` | Lawyers saved by clients |
| `articles` | Magazine content and its draft/review/published lifecycle |
| `services` | Administrator-managed legal specialties |
| `lawyer_specialties` | Lawyer-to-service mapping |
| `faqs` | Public frequently asked questions |
| `documents` | File metadata and links to owners/questions/consultations |
| `conversations` | One-to-one text consultation conversations |
| `chat_messages` | Conversation messages |
| `admin_permissions` | Fine-grained delegated administrator permissions |
| `settings` | Product and branding key/value configuration |
| `messages` | Support requests and complaints |
| `sessions` | Bearer tokens and expiration timestamps |

### Important relationships

```text
users 1─1 lawyers
users 1─N questions / consultations / orders / documents / sessions
questions N─N lawyers (question_assignments)
questions 1─N answers
lawyers N─N services (lawyer_specialties)
lawyers 1─N appointment_slots
consultations 0..1─1 appointment_slots
consultations 1─0..1 orders
consultations 1─0..1 reviews
consultations 1─0..1 conversations 1─N chat_messages
```

SQLite is opened with:

- `foreign_keys = ON`
- `journal_mode = WAL`
- `busy_timeout = 5000`

`server/db.mjs` installs and upgrades the runtime schema and creates seed data. `db/schema.ts` is the typed schema reference. Schema changes currently need to remain synchronized across the Drizzle schema, SQL migration, and runtime SQL in `server/db.mjs`.

## 9. Domain Workflows

### Free legal question

```text
new / pending_assignment
  → assigned to one or more lawyers
  → one or more answers submitted
  → answered
  → published publicly when consent and moderation allow it
```

Rules:

- The free-question quota comes from settings.
- `max_question_lawyers` limits the number of responding lawyers.
- An administrator can assign lawyers or cancel the entire question.
- Question documents are downloadable only by authorized participants.

### Text consultation

```text
Create consultation and order
  → simulated payment or pending_payment
  → create conversation for type=text
  → exchange messages within message_limit
  → completed / closed
  → optional client review
```

The message allowance counts consecutive speaker turns, not raw message rows. Multiple consecutive messages from the same participant count as one turn.

### Phone and in-person consultations

```text
Select lawyer and slot
  → atomically reserve slot
  → order / checkout
  → coordination and confirmation
  → in_progress
  → completed or cancelled
```

- Only an available future slot can be booked.
- A unique index prevents one slot from being attached to multiple consultations.
- Non-text consultations do not create chat conversations.
- Cancellation can release the slot and mark the order `refund_pending`.
- A completed consultation can be rebooked in all three service modes.

### Payment

Payments are currently simulated. The API exposes checkout plus `pay` and `cancel` operations, but no external payment gateway is connected.

Key order states:

```text
pending_payment → paid → refund_pending → refunded
```

Base amount, urgency rate, urgency surcharge, commission rate, and commission amount are stored explicitly so reports and audits can reconstruct the calculation.

### Reviews

A review must be attached to a relevant consultation, its rating must be between 1 and 5, and only one review can exist for each consultation. Administrator approval controls publication. Lawyer ratings are recomputed from approved reviews.

## 10. API Surface

The API uses only `GET`, `POST`, and `OPTIONS` and returns JSON with `Cache-Control: no-store`.

### Public and account endpoints

- `GET /api/health`
- `GET /api/bootstrap`
- `POST /api/visit`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/forgot-password` — currently a local stub
- `GET /api/me`
- `POST /api/profile`

### Files and media

- `POST /api/avatar`
- `POST /api/article-cover`
- `POST /api/site-media`
- `GET /api/media/:id`
- `POST /api/documents`
- `GET /api/documents/:id/download`

### Product domain

- `POST /api/questions`
- `POST /api/answers`
- `POST /api/consultations`
- `POST /api/consultation/action`
- `GET /api/checkout/:trackingCode`
- `POST /api/checkout/:trackingCode/pay`
- `POST /api/checkout/:trackingCode/cancel`
- `POST /api/chat/messages`
- `POST /api/reviews`
- `POST /api/bookmarks`
- `POST /api/messages`
- `POST /api/articles`

### Dashboard and administration

- `GET /api/dashboard`
- `GET /api/admin/stats`
- `POST /api/notifications/read`
- `POST /api/lawyer/action`
- `POST /api/admin/action`

The final two endpoints are command-style endpoints in which an `action` field chooses the operation. This is efficient for a local prototype but becomes harder to type, document, authorize, and evolve as the system grows.

## 11. Authentication and Authorization

### Dadrah authentication

- Passwords use `scrypt`, a random 16-byte salt, and a 64-byte derived key.
- Hash comparison uses `timingSafeEqual`.
- Random session tokens are stored in `sessions`.
- `currentUser()` returns only active users with unexpired sessions.
- Roles are exactly `client`, `lawyer`, and `admin`.

### Delegated administrator permissions

The primary administrator is identified by `primary_admin_id`. Other administrators receive fine-grained permissions:

```text
users.manage
lawyers.verify
questions.assign
consultations.manage
content.manage
services.manage
reviews.manage
support.manage
documents.manage
finance.view
payments.manage
reports.view
settings.manage
admins.manage
```

### ChatGPT-host authentication helper

`app/chatgpt-auth.ts` reads OpenAI host authentication headers and builds safe sign-in/sign-out return paths. It is separate from Dadrah's internal session system and is not central to the current UI flow. A production deployment should explicitly decide whether host authentication replaces, complements, or is removed in favor of the internal system. Two identity sources should not coexist without a clear policy.

## 12. File and Input Security

- Maximum JSON body: 1 MB.
- Maximum file body: 10 MB.
- Text inputs are NFKC-normalized and trimmed.
- IDs and future timestamps are validated.
- Upload MIME type and file structure are inspected.
- Stored filenames are separated from user-provided original names.
- `safeDiskPath` prevents path escape from the upload directory.
- Document download checks ownership, associated lawyer access, or administrator permission.
- Current CORS is `*` and must be narrowed for production.

## 13. Administrator-Managed Settings

The `settings` table is a key/value registry. Major groups include:

- Branding: site name, light/dark logos, favicon, and hero images.
- Contact: support phone, email, and address.
- Features: free questions, global in-person consultations, and maintenance mode.
- Quotas: free questions, lawyers per question, and text-message turns.
- Finance: price ranges, urgency surcharge, and commission.
- Content: footer, terms, privacy, trust items, and article tags.
- Statistics: visibility, title, and public labels.

Values are text, so structured values are JSON-encoded. Every consumer needs a safe fallback; `parseSetting` and `jsonSetting` provide that behavior.

## 14. Visual System and CSS

`globals.css` is a large global stylesheet covering:

- the locally hosted Sahel font;
- colors, shadows, and other design variables;
- light and dark themes through `data-theme`;
- public pages, cards, modals, and dashboards;
- primary breakpoints around 1100, 1050, 780, and 520 pixels;
- scroll reveal with respect for `prefers-reduced-motion`;
- status colors, skeletons, forms, tables, and upload states.

The current design mindset is formal legal trust expressed through navy and gold. For a 2026 redesign, stabilize the token system before rewriting components:

```text
semantic colors → surface levels → typography scale → radius → shadow/blur → motion
```

Liquid Glass should be limited to navigation, trust rails, and overlays. Legal copy, forms, and dashboard tables should remain opaque and high-contrast. Polymorphic depth is most useful when it communicates that an element is interactive.

## 15. Test Strategy

### `api-workflow.test.mjs`

Runs a real API workflow in a separate process and verifies role security, questions, consultations, documents, simulated checkout, answers, and cleanup.

### `rendered-html.test.mjs`

Checks:

- server rendering of the Persian application shell;
- local font and requested design colors;
- public routes and deep-link wiring;
- distinct menus for all three dashboard roles;
- the local API and relational schema;
- question assignment, role guards, and server-side checkout.

### `upgrade-requirements.test.mjs`

Protects upgraded features such as real avatar assets, dark mode, the account menu, settings-driven content, free-question limits, phone coordination, chat-turn counting, full-question cancellation, urgency surcharge, articles and tags, notification badges, lawyer price constraints, chat documents, tracking codes, and rebooking.

Many UI tests also inspect code strings and structure. During a large refactor, migrate these toward behavioral component and user-flow tests to reduce false failures.

## 16. Current Strengths

- The entire project runs without heavy external infrastructure.
- The relational data model is broad enough for a realistic product demo.
- Important invariants are also enforced through database constraints.
- Role security, delegated permissions, and document access receive serious treatment.
- Prices and state transitions are controlled by the server.
- Seed data creates meaningful end-to-end scenarios.
- The public UI has fallback content when the local API is unavailable.
- Tests turn many product requirements into executable contracts.

## 17. Technical Debt and Risks

### 1. Large monolithic UI file

`dadrah-app.tsx` contains many pages, domain workflows, and all dashboards. This makes navigation, isolated testing, parallel work, and review increasingly difficult.

### 2. Manual API router and command endpoints

One large file handles routing, validation, authorization, SQL, and business logic. Routes, services, repositories, policies, and validation should eventually be separated.

### 3. Multiple schema representations

The Drizzle schema, migration SQL, and runtime SQL must remain manually synchronized. Schema drift is a meaningful risk.

### 4. Broad use of `any`

The UI/API boundary is weakly typed. Shared request/response types and runtime schemas such as Zod or Valibot would catch contract errors earlier.

### 5. Client-held Bearer session and open CORS

These are acceptable for local development. Production needs secure HttpOnly cookies or a hardened token policy, a CSRF strategy, session rotation, and an origin allowlist.

### 6. Simulated payment and password recovery

Neither is production-ready. Product copy and deployment documentation must keep their simulated status explicit.

### 7. Local disk uploads

Local storage works for one development instance. Multi-instance deployment needs object storage, malware scanning, retention rules, and signed downloads.

## 18. Recommended Refactoring Roadmap

### Phase 1: Stabilize contracts

- Define shared request and response types.
- Add runtime validation schemas next to commands.
- Document question, consultation, order, and article state machines.
- Add tests for invalid transitions.

### Phase 2: Split the frontend

```text
app/features/public
app/features/auth
app/features/questions
app/features/consultations
app/features/chat
app/features/dashboard/client
app/features/dashboard/lawyer
app/features/dashboard/admin
app/components/ui
app/lib/api
app/lib/routing
```

### Phase 3: Split the API

```text
server/routes
server/services
server/repositories
server/policies
server/validation
server/storage
```

### Phase 4: Establish one schema source

- Generate migrations only from Drizzle.
- Add a runtime migration runner.
- Separate seed logic from migration logic.
- Detect schema drift in CI.

### Phase 5: Production hardening

- Integrate a real payment gateway with idempotent webhooks.
- Add email/SMS for password recovery and notifications.
- Move files to object storage and scan uploads.
- Add rate limiting, audit logs, and observability.
- Harden sessions and restrict CORS.
- Implement and test backup and restore procedures.

## 19. Adding a New Feature

Use this sequence:

1. Define the entity and allowed state transitions.
2. Decide which behavior is configurable and which is a domain invariant.
3. Add database fields and constraints.
4. Keep migration and runtime database logic synchronized.
5. Define authorization before implementing the handler.
6. Add server-side validation and payload limits.
7. Return a stable, typeable API response.
8. Implement loading, empty, error, success, and disabled UI states.
9. Verify keyboard access, labels, contrast, and reduced motion.
10. Test authorized, unauthorized, happy-path, and invalid-transition behavior.
11. Update README and this document when architecture changes.

Important rule: a hidden or disabled button is not a security policy. Every protected action must be enforced on the server.

## 20. Redesign Checklist

Before a full visual redesign:

- Preserve routes and workflow behavior.
- Identify selectors and strings used by tests.
- Extract color, spacing, typography, and surface tokens.
- Prototype the header, hero, and base card first.
- Test Persian text contrast over actual glass surfaces.
- Keep dashboard forms and tables opaque.
- Test both narrow mobile and wide desktop layouts.
- Cover dark, loading, empty, error, and modal states.
- Preserve image ratios, fallbacks, and lazy loading.
- Run `npm run lint`, `npm run build`, and `npm test` after each major stage.

## 21. Behavioral Contracts to Preserve

- Default API port: `8787`, configurable with `DADRAH_API_PORT`.
- Development web port: `3010`.
- Database file: `data/dadrah.sqlite`.
- Upload directory: `data/uploads`.
- Roles are exactly `client`, `lawyer`, and `admin`.
- Authentication uses a Bearer token.
- API paths use the `/api` prefix.
- Text consultations have conversations; phone and in-person consultations do not.
- A review is uniquely associated with a consultation.
- A booked slot cannot belong to a second consultation.
- The primary administrator is identified through a setting.
- Public settings are explicitly allowlisted; internal settings must not leak through bootstrap.

## 22. Definition of Done

A change is complete when:

- behavior for every affected role has been checked;
- server-side validation and authorization exist;
- the appropriate database constraint exists;
- loading, error, empty, success, and disabled states are handled;
- mobile and RTL layouts remain correct;
- documents and sensitive data are inaccessible without permission;
- the build, lint, and relevant tests pass;
- reset and seed workflows still function;
- architecture or contract changes are documented.

## 23. Final Mental Model

Dadrah should not be understood as only a landing page and lawyer directory. Its core is a **role-aware legal workflow engine** with a public interface layered on top.

The architectural value comes from four responsibilities:

1. Convert an ambiguous user problem into a structured legal request.
2. Deliver that request only to authorized and relevant participants.
3. Maintain a traceable record of status, payment, files, and communication.
4. Build trust through control, transparency, privacy, and a clear next action.

Every redesign and refactor should preserve those responsibilities. The visual language may be Liquid Glass, Polymorphic, Editorial, or something else, but legal content, case status, cost, privacy, and the next user action must always remain clearer and more important than decoration.
