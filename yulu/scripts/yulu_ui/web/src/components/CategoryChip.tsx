import "./CategoryChip.css";

export type Category = "summary" | "cleanup" | "voicemail";

export interface CategoryChipProps { category: Category; }

export function CategoryChip({ category }: CategoryChipProps) {
  return <span className="category-chip" data-category={category}>{category}</span>;
}
