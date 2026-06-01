import { redirect } from "next/navigation";

/**
 * /ceremonies -- redirect entry point.
 *
 * Story 7.5 does not ship a dedicated list page; the canonical surface
 * is the combined `/ceremonies/calendar` view (consecrations +
 * interments). The legacy `/interments` list page remains for the
 * interments-only operational view.
 */
export default function CeremoniesIndexPage() {
  redirect("/ceremonies/calendar");
}
