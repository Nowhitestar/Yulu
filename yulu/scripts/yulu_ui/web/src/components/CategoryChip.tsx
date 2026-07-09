import { useT } from "../i18n/LanguageProvider.js";
import "./CategoryChip.css";

export type Category = "summary" | "cleanup" | "voice";

export interface CategoryChipProps { category: Category; }

export function CategoryChip({ category }: CategoryChipProps) {
  const t = useT();
  return <span className="category-chip" data-category={category}>{t(`category.${category}`)}</span>;
}
