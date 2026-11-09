# ui

The default screens and slots, in React Native, for the phone and (through react-native-web) the web. Presentation and local view state only; data comes from `client/react` hooks.

- Remote images aren't loaded: the contract carries `MediaKey`s, not URLs, and M1 has no media origin. Avatars are initials; image embeds are links that show their host.
- Pass a single style object (`StyleSheet.flatten`) to expo-router `Link` and to a `Pressable` under `<Link asChild>`: on the web a style array there reaches the DOM and crashes the page.
- Links out of the app go through `ExternalLink` (`rel="noopener noreferrer nofollow"` on the web).
- Lists stop loading automatically after a failed page and show a retry.
