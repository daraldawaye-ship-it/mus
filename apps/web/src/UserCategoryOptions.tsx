import { userCategories } from "../../../packages/contracts/src/user-category";

export function UserCategoryOptions() {
  return userCategories.map(category => (
    <option key={category} value={category}>{category}</option>
  ));
}
