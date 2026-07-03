# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in EnergiaMind, please report it responsibly using one of the following channels:

- **Email:** [ltridung1@gmail.com](mailto:ltridung1@gmail.com)
- **Security Team:** [security@energiamind.io](mailto:security@energiamind.io)

Please include the following in your report:

1. A description of the vulnerability and its potential impact
2. Detailed steps to reproduce the issue
3. Any proof-of-concept code or screenshots
4. Your assessment of severity (Critical / High / Medium / Low)

**Do not** open a public GitHub issue for security vulnerabilities.

## Response Timeline

| Stage | Timeframe |
|---|---|
| **Acknowledgement** | Within **48 hours** of receipt |
| **Initial Assessment** | Within **1 week** of acknowledgement |
| **Fix & Disclosure** | Within **30 days** of confirmed vulnerability |

We will keep you informed of our progress throughout the process. If the fix requires more than 30 days, we will communicate the revised timeline and reasoning.

## Scope

The following are **in scope** for security reports:

- Authentication and authorization bypass (JWT, RBAC, session management)
- SQL injection, XSS, CSRF, or other injection vulnerabilities
- Sensitive data exposure (credentials, tokens, PII leaks)
- Server-side request forgery (SSRF)
- Insecure direct object references (IDOR)
- Cryptographic weaknesses (weak hashing, broken token rotation)
- Misconfigured security headers (CSP, CORS, HSTS)
- Privilege escalation between user roles
- WebSocket authentication or authorization flaws

## Out of Scope

The following are **out of scope** and will not be accepted:

- Denial-of-service (DoS/DDoS) attacks
- Social engineering or phishing attacks against project maintainers
- Vulnerabilities in third-party dependencies with no demonstrated exploit path
- Issues only reproducible on outdated or unsupported browsers
- Reports from automated scanning tools without manual verification
- Physical security attacks
- Brute-force attacks against rate-limited endpoints functioning as designed

## Safe Harbor

We consider security research conducted in good faith to be authorized and will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and service disruption
- Only interact with accounts they own or with explicit permission from account holders
- Report vulnerabilities promptly and provide sufficient detail for reproduction
- Do not publicly disclose vulnerabilities before the agreed-upon fix timeline
- Do not exploit a vulnerability beyond what is necessary to demonstrate the issue

We commit to working with researchers to understand and resolve issues quickly, and we will not take legal action against individuals who discover and report vulnerabilities in accordance with this policy.
