import type { Metadata } from "next";
import { EarnPage } from "@/features/earn/EarnPage";

export const metadata: Metadata = { title: "Earn · AfterHours" };

export default function Page() {
  return <EarnPage />;
}
