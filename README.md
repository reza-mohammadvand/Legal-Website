# Dadrah Legal Consultation Platform

Dadrah is a full-stack, Persian-language legal consultation platform built for local development and product testing. It provides distinct experiences for clients, lawyers, and administrators, with a responsive RTL interface, a local HTTP API, and a persistent SQLite database.

The project runs entirely on your machine. It does not require a hosted backend, an external database, or a ChatGPT-hosted domain.

## Highlights

- Persian, right-to-left interface using the local Sahel font family
- Responsive public website and role-specific dashboards with persistent light and dark themes
- Exact primary brand colors: `#1A237E` and `#EFBF04`
- Live public statistics, configurable trust content, and an administrator-managed footer
- Public lawyer directory with search, filtering, sorting, profiles, availability, and bookmarks
- Administrator-defined specialty catalog with multi-specialty lawyer profiles and exact directory filtering
- Interactive specialty cards with editable back-side case examples and links to matching lawyers
- Uploadable light/dark logo variants, browser favicon, and an ordered multi-image home hero
- Three free legal questions per client by default, with optional anonymous publication consent
- Automatic assignment to top verified lawyers and an administrator-configurable answer limit
- Separate lawyer answers shown to the client as soon as each one arrives, with administrator-controlled public publication
- Paid text consultations with separate, configurable conversation-turn quotas for clients and lawyers
- Support-coordinated phone consultations and slot-based in-person booking
- Administrator-configurable urgent-request surcharge with a server-calculated price breakdown
- Atomic appointment-slot reservation to prevent double booking
- Simulated local checkout, payment tracking, cancellation, and refund states
- Secure text-consultation rooms, persisted chat messages, consultation-specific attachments, and visible tracking codes
- Protected in-chat document upload and download with file type and size validation
- One-click rebooking after completion for text, phone, or in-person consultation with the same lawyer
- Client avatars, lawyer onboarding documents, and administrator verification
- Verified-consultation review flow with administrator moderation
- Searchable legal questions, reviews, and legal magazine articles with cover images and controlled tags
- Lawyer article submissions with administrator approval before publication
- Role-aware notifications and navigation badges in all three dashboards
- Administration of users, lawyers, verification, consultations, payments, content, services, FAQs, reviews, support, reports, permissions, and site settings
- Granular administrator capabilities with an immutable primary administrator
- Seeded data and three ready-to-use demo accounts

## Technology Stack

| Layer | Technology |
| --- | --- |
| Web application | React 19, Next.js-compatible App Router, Vinext, Vite |
| Language | TypeScript and modern JavaScript modules |
| Styling | Custom responsive CSS, RTL layout, local Sahel fonts |
| Icons | Lucide React |
| API | Node.js HTTP server |
| Database | SQLite using Node's built-in SQLite support |
| Schema | Drizzle ORM schema and SQL migration |
| Authentication | Token-based local sessions and scrypt password hashing |
| Tests | Node.js test runner, rendered HTML checks, and API workflow tests |

## Requirements

- Node.js `22.13.0` or newer
- npm

The SQLite implementation used by this project is included with supported Node.js versions and does not require a separate database server.

## Quick Start

Clone the repository and install dependencies:

```bash
git clone https://github.com/reza-mohammadvand/Legal-Website.git
cd Legal-Website
npm install
```

Start the frontend and local API together:

```bash
npm run dev
```

Open the following URLs:

| Service | URL |
| --- | --- |
| Website and dashboards | http://localhost:3010 |
| Local API | http://localhost:8787 |
| API health check | http://localhost:8787/api/health |

`npm run dev` starts both services in one process. Stop it with `Ctrl+C` when you are finished.

## Demo Accounts

The database is seeded automatically on first start.

| Role | Username | Password |
| --- | --- | --- |
| Client | `client` | `Client123!` |
| Lawyer | `lawyer` | `Lawyer123!` |
| Primary administrator | `admin` | `Admin123!` |

Use each account to inspect its separate navigation, permissions, data, and workflows.

## Core Workflows

### Free legal question

1. A client selects a legal topic and describes the issue. Each account has three free questions by default.
2. The client can upload a supporting PDF, JPG, or PNG file.
3. The client decides whether an anonymized version may be published.
4. A direct question goes to the selected lawyer. Otherwise, it is automatically assigned to the highest-ranked verified lawyers.
5. An administrator can reassign the question, up to the configurable maximum number of lawyers.
6. Authorized lawyers answer once from their dashboards and can immediately access attachments inside that question's chat thread.
7. Each answer appears privately in the client's chat as soon as it arrives; the client never has to wait for all assigned lawyers. Public display still requires client consent.
8. After an answer is received, the client can continue with that lawyer through a paid text consultation.

An authorized administrator can also cancel a free question as a whole. Cancellation closes its active assignments and notifies the client and assigned lawyers. The default maximum is three lawyer answers per question, and the administrator can change both this limit and the per-client free-question quota.

### Paid text consultation

1. A client continues from a lawyer's free answer.
2. The server creates a priced text consultation linked to the original question.
3. After the simulated checkout, a private conversation is opened.
4. The client and lawyer can each use three conversation turns by default. Multiple consecutive messages from the same person count as one turn.
5. The conversation closes after both participants use their turn quotas; the administrator can change the quota for future consultations.

For text, phone, and in-person services, the client can mark a request as urgent. The API calculates the configured surcharge from the stored lawyer tariff, records the base amount and surcharge separately, and uses the final amount for the order and commission.

### Phone consultation

1. The client selects a lawyer and describes the topic; no date or time is requested from the client.
2. The API validates the lawyer and computes the price from the stored server-side tariff.
3. The local payment is recorded as simulated and a tracking code is created.
4. The client receives a notification that support will call to coordinate the appointment.
5. A lawyer records private phone availability, visible only to authorized administrators.
6. An administrator selects an available slot, and the confirmed time then appears in the client's and lawyer's dashboards.
7. Phone requests and their attachments remain on the consultation record and never create a text chat room.

### In-person consultation

1. A verified lawyer creates and manages available appointment slots.
2. The client selects a real available slot on the lawyer's profile.
3. SQLite reserves the slot and creates the consultation and order in one transaction.
4. A database constraint and guarded update prevent the same slot from being booked twice.

### Consultation lifecycle

The platform supports payment, assignment, support coordination, acceptance or rejection, an active consultation room, completion, cancellation, review eligibility, and administrative follow-up. Dashboard progress indicators expose the current stage, tracking codes link consultations to their payments, and protected files stay inside the relevant chat. After completion, the client can immediately book another text, phone, or in-person consultation with the same lawyer.

## Dashboards

### Client dashboard

- Overview and current activity
- Consultations and cases
- Appointments and calendar
- Consultation messages
- Protected documents
- Orders and invoices
- Free questions and lawyer answers
- Bookmarked lawyers
- Support requests and complaints
- Editable personal profile with avatar upload

### Lawyer dashboard

- Performance overview and online availability
- New consultation requests
- Available appointment-slot management
- Cases and clients
- Consultation rooms and messages
- Authorized documents
- Assigned legal questions and answers
- Revenue and commission summary
- Reviews and performance metrics
- Professional profile, service pricing within administrator-defined ranges, and verification documents
- Phone and in-person availability management
- Article writing and submission for administrator review

### Administrator dashboard

- Platform overview and operational metrics
- Consultation requests and urgent cases
- User management
- Lawyer verification and document review
- Question assignment and answer publication
- Consultation lifecycle management
- Protected document moderation
- Orders, commissions, refunds, and financial reporting
- Article, FAQ, and specialty-card management
- Article tag management, cover uploads, drafts, and lawyer-submission approval
- Review moderation
- Support and complaint handling
- Reports, consultation price ranges, quotas, legal text, trust content, public statistics, full footer settings, and brand media
- Administrator creation and granular permission management
- Direct link to view the public website

## Database

The application stores its local data in:

```text
data/dadrah.sqlite
```

The schema contains 21 related tables covering:

- users, lawyers, lawyer specialties, sessions, and administrator permissions
- questions, question assignments, and answers
- appointment slots, consultations, orders, and reviews
- bookmarks, documents, conversations, and chat messages
- articles, services, FAQs, support messages, and settings

The source schema is maintained in `db/schema.ts`, while `drizzle/0000_dadrah_core.sql` contains the corresponding SQL migration.

Local database files and uploaded documents are excluded from Git.

### Reset demo data

Stop the running development server, then run:

```bash
npm run db:reset
npm run dev
```

This removes the local SQLite database and test uploads. Fresh seed data is created on the next start.

## Available Commands

```bash
npm run dev          # Start the web application and API
npm run dev:web      # Start only the frontend
npm run dev:api      # Start only the API
npm run build        # Create a production frontend build
npm test             # Build and run all automated tests
npm run test:api     # Run the end-to-end API workflow test
npm run lint         # Run ESLint
npm run db:check     # Validate the 20-table SQL migration
npm run db:reset     # Reset the local database and uploaded test files
```

## Project Structure

```text
app/                       React application, routes, data adapters, and styles
db/                        Drizzle schema and database integration
drizzle/                   SQLite migration
public/                    Local fonts and visual assets
scripts/                   Local development and schema validation scripts
server/                    SQLite setup, seed data, API, and reset utility
tests/                     Rendered-page and API workflow tests
```

## Security Measures

This local build includes several safeguards that are also useful as a production foundation:

- scrypt password hashing with per-user salts
- constant-time password comparison
- random, expiring authentication tokens
- role and capability checks on protected endpoints
- server-authoritative consultation pricing
- atomic slot booking and uniqueness constraints
- ownership checks for questions, orders, chats, and documents
- publication consent enforcement for public answers
- randomized stored filenames
- MIME type, extension, and file-size validation
- protected document download endpoints
- request-body size limits and parameterized SQL statements

## Local Payment Notice

No real payment gateway is connected. Clicking the payment action records a simulated successful payment and does not charge a bank account. Before production use, replace this flow with a trusted gateway, signed callbacks, amount reconciliation, idempotency controls, and audited refund handling.

## Production Checklist

This repository is intended for local development, product review, and workflow testing. Before processing real legal matters or personal data, add and validate at least the following:

- HTTPS, production secrets, and restrictive CORS configuration
- a real payment gateway and verified callback flow
- password recovery and verified email or SMS delivery
- rate limiting, abuse prevention, and audit logs
- encrypted object storage, malware scanning, and retention rules
- database backups and disaster recovery procedures
- monitoring, alerting, and independent security testing
- reviewed terms, privacy policy, consent language, and legal disclaimers

## License

No open-source license has been added to this repository. All rights are reserved unless the repository owner states otherwise.
