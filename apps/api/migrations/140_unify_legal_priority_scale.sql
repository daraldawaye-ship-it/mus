-- Unify legal case and task priorities: 1 is highest, 10 is lowest.
-- Priority 0 is kept for cases without a chosen priority.
-- Preserve relative urgency by reversing the old nonzero 1..10 scale once.
UPDATE legal_cases
SET priority = 11 - priority,
    revision = revision + 1,
    updated_at = now()
WHERE priority BETWEEN 1 AND 10;

-- The unspecified (0) cases always sort after all explicitly ranked cases.
DROP INDEX IF EXISTS legal_cases_priority_idx;
CREATE INDEX legal_cases_priority_idx
ON legal_cases (status, (priority = 0), priority ASC, id DESC);
