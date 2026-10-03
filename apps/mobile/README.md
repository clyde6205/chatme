# CHATme Android (Expo / React Native)

This is the pre-existing Expo SDK 54 app, moved here unchanged from the repository root. It currently renders a single placeholder screen.

It is intentionally outside the pnpm workspace until it is rebuilt on `@chatme/contracts` and `@chatme/i18n` (Phase 1b). Known issues found during the architecture assessment (`docs/architecture-assessment.md`):

- `assets/icon.png`, `splash.png`, `favicon.png` are empty files; `adaptive-icon.png` is not a valid image.
- Release builds are signed with the debug keystore.
- Package id disagrees between `app.json` (`com.clyde6205.chatmepro`), Gradle (`com.chatmepro`) and Kotlin sources.
- Stream Chat and `react-native-voice` dependencies are unused; Stream conflicts with the owned, provider-neutral chat backend.

Run (requires Android SDK): `npm install && npx expo run:android`.
