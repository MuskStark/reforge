import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminSection } from "@/components/admin/admin-section";
import { ADMIN_SECTION_META, isAdminSection } from "@/lib/shell-nav";

/** 管理后台的一个分区:/admin/processes · systems · users · stages · channels */
export default async function AdminSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!isAdminSection(section)) notFound();
  return <AdminSection section={section} />;
}

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }): Promise<Metadata> {
  const { section } = await params;
  return { title: isAdminSection(section) ? `${ADMIN_SECTION_META[section].title} — ReForge` : "管理后台 — ReForge" };
}
