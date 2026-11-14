import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SPHEREx Time Machine (clásico) | Compara el cielo infrarrojo",
  description: "Versión clásica: compara observaciones infrarrojas de SPHEREx tomadas en distintas fechas, con procedencia científica y simulación educativa separadas.",
};

export default function ClassicLayout({ children }: { children: React.ReactNode }) {
  return children;
}
