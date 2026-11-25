# Samples

This is Michael's personal, in-progress contract-review tool.

These files are sample output from a lease extraction run on [docs/samples/sample-lease.pdf](samples/sample-lease.pdf). Blank form fields are reported as blank. The extractor does not guess a number or a date that the form left empty.

## Files

- [docs/samples/sample-lease.pdf](samples/sample-lease.pdf) — the lease that was uploaded for this run.
- [docs/screenshots/lease-extraction-1.png](screenshots/lease-extraction-1.png) — rent, lease term, and renewal. The rent amount, due date, term length, and dates are left blank because the form's blanks are blank. Frequency is monthly. Renewal options are present, and no option is selected.
- [docs/screenshots/lease-extraction-2.png](screenshots/lease-extraction-2.png) — security deposit and pets. The deposit amount is left blank. Currency is USD and frequency is one time. Pets are limited to those legally required because of a disability or handicap.
- [docs/screenshots/lease-extraction-3.png](screenshots/lease-extraction-3.png) — termination and holdover. Default lets the lessor declare the lease terminated after more than 15 days' notice. A holdover tenancy is terminable on 30 days' notice by either party.
