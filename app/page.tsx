import type { Metadata } from "next";
import { InventoryAuditorApp } from "./components/InventoryAuditorApp";

export const metadata: Metadata = {
  title: "Inventory Auditor",
  description: "Clear production forecasts for every brand and location.",
};

export default function Home() {
  return <InventoryAuditorApp />;
}
