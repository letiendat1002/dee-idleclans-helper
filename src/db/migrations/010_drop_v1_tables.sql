-- v1 tables left behind by the v2 schema and read by nothing since (CONVENTIONS.md §9).
-- Verified empty before the drop: watchlist/clans/guilds/payments/users all held 0 rows, and
-- no source file names any of them. Child tables first, because clans and watchlist point at
-- guilds.
DROP TABLE IF EXISTS watchlist;
DROP TABLE IF EXISTS clans;
DROP TABLE IF EXISTS guilds;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS users;
