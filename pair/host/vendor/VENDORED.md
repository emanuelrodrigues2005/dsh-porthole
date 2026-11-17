# Vendored QR encoder

## What is here

| file | purpose |
| --- | --- |
| `qrcodegen.js` | QR Code Model 2 encoder, byte mode, error-correction level M, automatic version (1–40). Plain ESM, no dependencies. |
| `qrcodegen.LICENSE.txt` | MIT licence for the encoder in this directory. |

## Provenance

The Pair design intended to vendor **Nayuki's QR Code generator library**
(MIT), <https://www.nayuki.io/page/qr-code-generator-library>, file
`typescript-javascript/qrcodegen.ts`. The implementation environment for this
bundle has **no web access**, so that file could not be fetched.

Instead, `qrcodegen.js` is an original implementation of ISO/IEC 18004 written
for this bundle, exposing the same small API shape (`encodeQr` returning a
boolean module matrix). It was not copied from Nayuki's source. The adaptation
relative to the upstream library is therefore: a fresh, dependency-free
encoder with this bundle's MIT licence, kept behind the same
`encodeQr(text, options)` → `{ matrix, version, size, mask }` surface.

Algorithm choices, all required by the Pair contract:

- byte mode only (`0100`), UTF-8 payload;
- error-correction level **M**;
- version chosen automatically as the smallest that fits;
- mask chosen by the ISO/IEC 18004 penalty rules (N1–N4, lowest-numbered mask
  wins ties).

## Verification performed

The matrices were compared byte-for-byte against an independent local QR
encoder (Kazuhiko Arase's QRCode.js, MIT, the copy vendored by npm's
`qrcode-terminal`) for five payloads (5, 76, 92, 100 and 1200 ASCII bytes,
versions 1, 5, 6, 6 and 29) and **all eight mask patterns**: 40 matrix
comparisons, zero differences. No code was copied from that library; it was
used only as a test oracle during development. The repository test suite also
asserts finder patterns, version growth, deterministic output and SVG geometry.

A live phone scan through a real Cloudflare tunnel was not performed in this
offline environment; see the Pair README for the operator path.
