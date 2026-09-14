import type { Metadata } from "next";
import { PositionsPage } from "@/features/positions/PositionsPage";

export const metadata: Metadata = { title: "Positions · AfterHours" };

export default function Page() {
  return <PositionsPage />;
}
