# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in EnergiaMind, please report it responsibly using the following channels:

- **Email:** [ltridung1@gmail.com](mailto:ltridung1@gmail.com)

## Dependency Vulnerability Management

All transitively introduced package vulnerabilities are audited and resolved using the npm `overrides` block defined in the root `package.json` to force resolution of secure, patched package versions:
- `adm-zip` is overridden to `^0.6.0` (resolves CVE-2026-39244 / GHSA-xcpc-8h2w-3j85).
- `esbuild` is overridden to `^0.25.0` (resolves GHSA-67mh-4wv8-2f99).

