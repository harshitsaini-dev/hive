-- Removes the manual sender-name override added an hour earlier.
--
-- It was the wrong answer to the right problem. Mail sent through Hive was
-- arriving as `harshitsaini.dev` instead of a name, and letting the name be
-- typed into Hive fixed that — by making the user do setup for something that
-- should simply work. Every mailbox already knows what it sends under: the
-- `From` header of its own sent mail says so, and those headers are indexed.
--
-- Dropped rather than left in place unused. A column nothing reads is a trap
-- for whoever next assumes it means something.

ALTER TABLE connected_accounts DROP COLUMN display_name;
