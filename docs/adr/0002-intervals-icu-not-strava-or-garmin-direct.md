# Activities come from intervals.icu, not Strava or Garmin Connect directly

A Garmin watch records everything, but Garmin has no public API for individuals. The unofficial Garmin libraries need a stored password and broke in an earlier prototype. Strava was not used as a dependency. intervals.icu is a free, official Garmin partner with a personal API key, so it is the Activity source. A manual Telegram Check-in (hours, metres climbed, effort) is the fallback when the watch wasn't recording.
