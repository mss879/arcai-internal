import { redirect } from "next/navigation";

/**
 * Website Progress folded into Projects (0113).
 *
 * A client's website build IS its project: the build percentage, preview
 * link, live address and launch date now live on the project row (0112) and
 * show on the project page and the client's portal. The board filtered to
 * website builds is what this page used to be. Kept as a redirect so old
 * bookmarks and the assistant's older links still land somewhere useful.
 */
export default function WebsiteProgressPage() {
  redirect("/projects?service=website&mode=table");
}
