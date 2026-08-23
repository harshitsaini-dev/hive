-- Lets the sending name be set in Hive, rather than only inferred from Gmail.
--
-- Hive asks Gmail for the display name on the matching `sendAs` alias, and
-- when there is one that is the right answer — mail sent through Hive then
-- looks identical to mail sent from Gmail. But it is not always there. Some
-- aliases carry no name at all, and the settings call can fail on its own
-- terms. When it comes back empty, Gmail falls back to showing the local part
-- of the address, so recipients see `harshitsaini.dev` where a name belongs.
--
-- Nothing to infer harder about: the person knows what they want to be called.
-- Null means "ask Gmail", which stays the default.

ALTER TABLE connected_accounts ADD COLUMN display_name TEXT;
