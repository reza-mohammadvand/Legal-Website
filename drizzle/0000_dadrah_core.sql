CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('client', 'lawyer', 'admin')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  avatar_url TEXT,
  province TEXT,
  city TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE lawyers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  license_number TEXT NOT NULL,
  specialties TEXT NOT NULL,
  bio TEXT NOT NULL,
  phone_price INTEGER NOT NULL,
  text_price INTEGER NOT NULL DEFAULT 0,
  in_person_price INTEGER,
  rating REAL NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  profile_completed INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0,
  online INTEGER NOT NULL DEFAULT 0,
  in_person_enabled INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES users(id),
  lawyer_id INTEGER REFERENCES lawyers(id),
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'public',
  status TEXT NOT NULL DEFAULT 'new',
  publish_allowed INTEGER NOT NULL DEFAULT 0,
  urgent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE question_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id) ON DELETE CASCADE,
  assigned_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'assigned',
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(question_id, lawyer_id)
);
--> statement-breakpoint
CREATE TABLE answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
  body TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE appointment_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  consultation_type TEXT NOT NULL DEFAULT 'phone',
  status TEXT NOT NULL DEFAULT 'available'
);
--> statement-breakpoint
CREATE TABLE consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES users(id),
  lawyer_id INTEGER REFERENCES lawyers(id),
  slot_id INTEGER REFERENCES appointment_slots(id),
  source_question_id INTEGER REFERENCES questions(id),
  message_limit INTEGER NOT NULL DEFAULT 3 CHECK(message_limit > 0),
  type TEXT NOT NULL,
  topic TEXT NOT NULL,
  description TEXT,
  scheduled_at TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'simulated_paid',
  status TEXT NOT NULL DEFAULT 'registered',
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES users(id),
  consultation_id INTEGER REFERENCES consultations(id),
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  commission_rate REAL NOT NULL DEFAULT 0,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paid',
  tracking_code TEXT NOT NULL,
  paid_at TEXT,
  refunded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES users(id),
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
  consultation_id INTEGER REFERENCES consultations(id),
  consultation_type TEXT NOT NULL,
  body TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(consultation_id)
);
--> statement-breakpoint
CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES users(id),
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(client_id, lawyer_id)
);
--> statement-breakpoint
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  author TEXT NOT NULL,
  author_user_id INTEGER REFERENCES users(id),
  cover_image TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  author_avatar TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  back_description TEXT NOT NULL DEFAULT '',
  case_types TEXT NOT NULL DEFAULT '[]',
  icon TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE lawyer_specialties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX lawyer_specialties_lawyer_service_unique ON lawyer_specialties(lawyer_id, service_id);
CREATE INDEX lawyer_specialties_service_idx ON lawyer_specialties(service_id);
--> statement-breakpoint
CREATE TABLE faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  lawyer_id INTEGER REFERENCES lawyers(id),
  question_id INTEGER REFERENCES questions(id),
  consultation_id INTEGER REFERENCES consultations(id),
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_id INTEGER NOT NULL UNIQUE REFERENCES consultations(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES users(id),
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE admin_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 1,
  UNIQUE(admin_id, permission)
);
--> statement-breakpoint
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  order_code TEXT,
  admin_reply TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX questions_status_idx ON questions(status);
--> statement-breakpoint
CREATE INDEX question_assignments_lawyer_idx ON question_assignments(lawyer_id, status);
--> statement-breakpoint
CREATE INDEX question_assignments_question_idx ON question_assignments(question_id);
--> statement-breakpoint
CREATE INDEX consultations_client_idx ON consultations(client_id);
--> statement-breakpoint
CREATE INDEX consultations_lawyer_idx ON consultations(lawyer_id);
--> statement-breakpoint
CREATE INDEX consultations_source_question_idx ON consultations(source_question_id);
--> statement-breakpoint
CREATE INDEX articles_author_status_idx ON articles(author_user_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX consultations_slot_unique_idx ON consultations(slot_id) WHERE slot_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX reviews_consultation_unique_idx ON reviews(consultation_id) WHERE consultation_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX appointment_slots_lawyer_idx ON appointment_slots(lawyer_id, starts_at);
--> statement-breakpoint
CREATE INDEX documents_owner_idx ON documents(owner_id, created_at);
--> statement-breakpoint
CREATE INDEX documents_question_idx ON documents(question_id);
--> statement-breakpoint
CREATE INDEX documents_consultation_idx ON documents(consultation_id);
--> statement-breakpoint
CREATE INDEX messages_user_idx ON messages(user_id, created_at);
--> statement-breakpoint
CREATE INDEX chat_messages_conversation_idx ON chat_messages(conversation_id, created_at);
