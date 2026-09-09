# Dependency security remediation

The 1.0 release updates Next.js to a fixed 16.3.x-or-newer version and pins
Sharp 0.35.4 for its patched image-decoding dependencies. See the
[Next.js advisory](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4) and
[Sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).

`extract-zip` 2.0.1 has no upstream fixed release for
[GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3).
The checked-in pnpm patch rejects archive symlinks escaping the destination,
rejects overwriting an existing symlink, and opens regular output files with
`O_NOFOLLOW` on supporting platforms. The existing
[GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv)
remediation is retained.

The audit accepts those two extract-zip advisories only for the exact reviewed
patch checksum. Regression tests exercise the installed transitive dependency
with a normal archive, a symlink-plus-duplicate-entry archive, and a pre-existing
symlink. There is no blanket advisory exemption. Remove the patch when an
upstream fixed release is adopted and passes these regressions.
