/**
 * The cemetery's public contact details, in one place.
 *
 * These were duplicated across five files (the footer, the contact
 * page, the services CTA, the pricing form's fallback copy). Now that
 * the enquiry forms fall back to "call us instead" when a submission
 * fails, a wrong or stale number is no longer a cosmetic problem — it
 * is the last resort for someone who could not reach us any other way.
 * One constant, one place to correct it.
 *
 * ⚠ NOT YET CONFIRMED BY THE CEMETERY. These values came from the
 * marketing-site draft. `docs/runbook.md` § "What needs cemetery client
 * sign-off before go-live" already lists the postal address and legal
 * entity as unconfirmed; the phone number and inbox belong on that
 * list too. Verify before the site goes public — an unanswered number
 * on a bereavement page is worse than no number at all.
 */

/** Display form, as it should appear in copy. */
export const CEMETERY_PHONE_DISPLAY = "+63 (72) 562-0187";

/** `tel:` href form — no spaces or punctuation. */
export const CEMETERY_PHONE_HREF = "tel:+63725620187";

export const CEMETERY_EMAIL = "care@apostlepaul.ph";
export const CEMETERY_EMAIL_HREF = `mailto:${CEMETERY_EMAIL}`;

/**
 * Office hours, as shown beside the phone number. Kept here so the
 * "call us instead" fallbacks can set an honest expectation about when
 * someone will actually pick up.
 */
export const CEMETERY_OFFICE_HOURS = "Daily, 7:00am – 6:00pm";
