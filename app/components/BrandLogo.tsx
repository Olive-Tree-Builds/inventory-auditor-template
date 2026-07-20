import Image from "next/image";
import type { CSSProperties } from "react";

type BrandLogoProps = {
  className?: string;
  decorative?: boolean;
  priority?: boolean;
  size?: number;
};

export function BrandLogo({
  className = "",
  decorative = true,
  priority = false,
  size = 40,
}: BrandLogoProps) {
  return (
    <span
      className={`brand-logo${className ? ` ${className}` : ""}`}
      style={{ "--brand-logo-size": `${size}px` } as CSSProperties}
      aria-hidden={decorative || undefined}
    >
      <Image
        src="/brand-logo-icon.svg"
        alt={decorative ? "" : "Inventory Auditor"}
        width={size}
        height={size}
        priority={priority}
      />
    </span>
  );
}
