-- 0029_mentor_role.sql
--
-- The 'mentor' role: post-sale relationship staff. Mentors keep paying
-- clients warm - touchpoints, health, upsell interest - and nothing else:
-- crm.eligible_callers filters on role = 'caller', so a mentor can never
-- receive a lead from distribution, and no floor policy names the role.
--
-- This file contains ONLY the enum value. migrate.sh wraps each file in a
-- single transaction, and Postgres will not let a value added by
-- ALTER TYPE ... ADD VALUE be used inside the transaction that added it -
-- so the value commits here and 0030 builds on it.

alter type crm.user_role add value if not exists 'mentor';
