-- channel.list reads most-followed first.
CREATE INDEX channels_rank ON channels(coalesce(follower_count, 0) DESC, key);
