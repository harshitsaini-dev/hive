-- The name Google itself has for the person who owns this mailbox.
--
-- Not the manual override that lived here briefly and was dropped: nobody
-- types this. It is read from Google's userinfo endpoint when the mailbox is
-- connected, which is the authoritative answer to "what is this person
-- called" and the only source that works for a brand-new account that has
-- never sent anything.
--
-- Null for mailboxes connected before this existed, and for anyone who
-- declined the profile scope. Both fall back to reading the name off the
-- `From` header of their own sent mail, which covers every established
-- mailbox — it is only a genuinely empty Sent folder that needs this.

ALTER TABLE connected_accounts ADD COLUMN sender_name TEXT;
