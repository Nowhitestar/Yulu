import "./CategoryChip.css";

export type Category = "summary" | "cleanup";

export interface CategoryChipProps { category: Category; }

export function CategoryChip({ category }: CategoryChipProps) {
  return <span className="category-chip" data-category={category}>{category}</span>;
}
