/**
 * Public route group layout — no auth required, minimal chrome.
 * Used by /login and (Phase 3) the customer-portal landing page.
 *
 * Brand surface (Apostle Paul Tier 1): `bg-brand-cover` is a globals.css
 * utility that paints the radial Ivory → Ivory-deep gradient from the
 * brand-guide cover treatment. Outdoor / high-contrast modes flatten it
 * to the plain `--page-bg`.
 */
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="bg-brand-cover flex min-h-screen items-center justify-center px-4 py-12">
      {children}
    </main>
  );
}
