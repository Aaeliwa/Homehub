# Future Meal Planner ↔ Recipes contract (V6.1: prepared, NOT implemented)

**Nothing for the planner exists in V6.1:** no screens, no `plannedMeals` collection, no rules, no grocery lists.

## Recipes (V6.1)

- **Path:** `homes/{h}/recipes/{recipeId}`.
- **`recipeId`** is a stable, immutable Firestore id. **Duplicate** creates a new id; **edits never change it**.
- **Recipes are never deleted:** `allow delete: if false`, and the UI only offers **archive**. Archived recipes stay readable, so existing references keep resolving.
- **Ingredient and step ids** are stable within a recipe: `ingredients[].id`, `steps[].id`.

## Future `homes/{h}/plannedMeals/{mealId}` (proposal)

```
{ date: 'YYYY-MM-DD', mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack', servings: int 1–100,
  recipeId: string | null,     // null = standalone meal (leftovers, takeaway) — then `title` is required
  title: string | null, notes: string | null, createdBy, createdAt, updatedBy, updatedAt, rev, schemaVersion }
```

**Rule intent:**
- a `recipeId`, when set, must `exists()` in the same Home;
- planner permissions are separate from `chef.*` and from Finance.

## Flows

1. **Recipe → "Add to Meal Planner":** choose date / meal type / servings. The planner stores `recipeId` only, never a copy of the recipe.
2. **Planner slot → select or search a recipe:** opens `#/m/chef` on that recipe (detail, video, steps, timers). The scaler starts from the planned `servings`.
3. **Archived recipe** in a slot: shown as "(archived)", still openable.

## Out of scope (also later)

Costs, budgets, nutrition, grocery purchases, external recipe APIs.
