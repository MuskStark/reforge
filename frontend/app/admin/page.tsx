import { redirect } from "next/navigation";

/**
 * 旧地址 /admin:管理后台的五个分区现在各有自己的地址(/admin/processes 等),
 * 这里只负责把书签、旧链接转到达第一个分区。
 */
export default function AdminIndexPage() {
  redirect("/admin/processes");
}
