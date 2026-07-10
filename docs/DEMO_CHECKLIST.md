# Property Manager Demo Checklist

## Demo Accounts

Use `Password123!` for every account.

- `pm@pacificridge.ca` - Property Manager: leasing, photos, leads, showings, and operations.
- `books@pacificridge.ca` - Bookkeeper: OCR review, reconciliation, Sentinel, and audit checks.
- `broker@pacificridge.ca` - Broker: compliance review, RTA signing, and audit verification.

## Recommended Walkthrough

1. Sign in as the Bookkeeper and open the Dashboard.
   - Confirm the Financial Integrity Bridge summary is populated.
   - Open Bills / OCR and review pending bills.
   - Approve or reject one pending-review bill to show human-in-the-loop controls.

2. Open Financial Sentinel.
   - Queue an e-Transfer with a realistic reference and sender.
   - Watch the queue counters and recent AI activity update.
   - Run reconciliation from the same page.

3. Open Reconciliation.
   - Review open discrepancies.
   - Mark one discrepancy as resolved.
   - Run reconciliation again to show the matching flow.

4. Sign in as the Property Manager.
   - Open Leads / Prospecting and advance one lead through the funnel.
   - Open Conversations and send a manual staff reply.
   - Open Showings & Calendar and confirm or cancel a pending tour.

5. Open AI Photos.
   - Select a unit.
   - Add an image URL if needed.
   - Trigger an enhancement and watch the processing state.

6. Sign in as the Broker.
   - Open Leases / RTA.
   - Generate an RTA draft and sign it as Broker.
   - Open Audit Trail and verify the hash chain.

## Reset Demo Data

From the repository root:

```bash
pnpm --filter @property-manager/api seed
```

The seed rebuilds the deterministic demo tenant and restores the walkthrough data.
