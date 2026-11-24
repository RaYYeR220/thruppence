# What the APIs were missing

Five things we needed while building Thruppence and had to work around.

1. **Even Hub: a sanctioned way to ask for attention while in the background.** A money ask is the one moment worth interrupting for, but a plugin can only draw while it is the app on screen. A user-approved "peek" (one line, rate-limited, dismissible) would let apps like ours stay closed until they matter, which fits "quiet tech" better than keeping the app open.

2. **Even Hub: a non-exportable signing key for plugins.** We keep the device key in the plugin's storage on the phone. A key handle backed by the phone's Keychain/Keystore, with a `sign(bytes)` call and no way to read the key out, would make "the glasses can sign, nothing can copy the key" a platform guarantee instead of an app promise.

3. **Telegram's built-in wallet: delegated spending with limits.** WalletTg cannot host extensions, so a capped allowance has to live in a second wallet that the user funds. Session keys with per-payment and per-day caps in the built-in wallet itself would let any device or agent spend safely from the wallet people already have.

4. **TON Agentic Wallet: limits in the box.** The current version deliberately ships without spending limits ("fund what you risk"). Our limits extension shows the pattern works with the official bytecode untouched; a vetted, published limits extension (or native caps) would save every builder from writing their own.

5. **Even Hub simulator: device status.** The simulator has no wear status, battery or connection events, so the "pay only while the glasses are worn" path can only be tested on hardware. Controls for `isWearing` and `connectType` in the simulator would close that gap.
