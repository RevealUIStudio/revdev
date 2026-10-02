# NOTICE provenance fixture

`notice-provenance-certificate.pem` is the public Fulcio signing certificate
from the saved, verified npm provenance bundle for `drizzle-orm@0.45.2`. Its
workflow identity is in `drizzle-team/drizzle-orm`. It contains no private key
or operator credential and is not a trust anchor. Tests use it only to parse
and bind an already-verified signer identity in synthetic verifier reports;
cryptographic verification remains the pinned npm verifier's responsibility.

Evidence: npm attestation endpoint
`https://registry.npmjs.org/-/npm/v1/attestations/drizzle-orm@0.45.2`, source
commit `273c78071d4841b497f5144734b38294df7ec64b`. Archived certificate validity
is handled by Sigstore's transparency evidence, not by accepting it as a
currently valid TLS certificate.
