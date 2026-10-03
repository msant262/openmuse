# Mobile image dependency compatibility

The workspace pins `image-size` 2.0.4 and applies the small, versioned
`patches/metro@0.83.3.patch`. Metro 0.83.3 passes a filename to its image parser
when collecting normal image assets. The new parser accepts bytes; the patch
reads the asset asynchronously before parsing it. The Flow source's upstream MIT
notice and the package's MIT license metadata remain intact; no license text is
removed from either patched file.

A global dependency override alone breaks normal PNG asset loading. The
regression test exercises Metro's actual `getAssetData` with regular/scaled PNG
files and `getAssetSize` with a byte buffer. A separate bounded child process
checks that a malformed zero-size JXL partial-stream box is rejected rather than
blocking the test runner or exhausting its memory.

The [upstream proposal #104](https://github.com/CopilotKit/openmuse/pull/104)
originally suggested 2.0.3. We use 2.0.4, the fixed version identified in the
[maintainer's HEIF/JXL advisory](https://github.com/image-size/image-size/security/advisories/GHSA-8jqf-8xqx-7xjx).
The dependency is present in the Expo/Metro build path; these checks do not claim
that the server exposes that parser through an unauthenticated upload endpoint.

When upgrading Expo/Metro, check its actual asset-loading call site and remove
the patch once the consumer supports the byte API. Preserve the pinned lockfile
and validate a frozen install, `tests/mobile-assets.test.ts`, and production
exports for web, Android and iOS containing a normal bundled PNG (currently
`apps/mobile/assets/capybara.png`). JavaScript/Hermes exports do not replace
native APK/IPA builds or physical-device acceptance.
