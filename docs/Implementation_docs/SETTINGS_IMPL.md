# Settings page implementation:

## Build and Deployment settings

1. Fields and save button are locked (read-only) by default
2. An "Edit" button with pencil icon on the left of the save button
3. When "Edit" is clicked, fields become editable and save button enables
4. Change detection between previous and new state to enable save button
5. On save: persist to backend first, then show floating popup
6. Floating popup: "Want to redeploy with the updated settings?" with Redeploy and Dismiss buttons
7. Popup auto-dismisses after 10 seconds
8. "Dismiss" does nothing
9. "Redeploy" triggers a redeploy

### Implementation details:

Here's what was changed in apps/frontend/app/project/[projectId]/settings/page.tsx:

1. Locked by default — All 4 build fields (buildCommand, installCommand, outputDirectory, rootDirectory) have readOnly={!buildEditing} with visual feedback (read-only:opacity-60 read-only:cursor-not-allowed).

2. Edit button — A <Pencil> icon + "Edit" button appears left of Save. Clicking it unlocks the fields. A "Cancel" button replaces it while editing, reverting any unsaved changes.

3. Change detection — A buildSnapshot state stores the last-saved values. The Save button is disabled={!buildEditing || !buildHasChanges} — it only enables when in edit mode AND fields differ from the snapshot.

4. Redeploy popup — After a successful save, a floating popup appears at fixed bottom-5 right-5 with "Want to redeploy with the updated settings?" and two buttons:
   - Redeploy — calls createDeployment(project.id) and navigates to the deployment detail page
   - Dismiss — closes the popup immediately
   - Auto-dismiss — popup disappears after 10 seconds via setTimeout
   - Timer cleanup on unmount and on any manual dismiss

## Delete project settings

Modify the ConfirmModal to add a validation input field for the delete action. 
1. Add a requireConfirmation prop (or similar) that enables the type-to-confirm feature
2. Add a confirmationText prop that specifies what the user needs to type
3. Add an input field below the description
4. Keep the confirm button disabled until the user types the correct text
5. Update the settings page to pass the project name

### Implementation details:

components/dashboard/ConfirmModal.tsx — Added optional confirmationPhrase prop:
- When provided, shows an input field with label Type {phrase} to confirm:
- The "Delete project" button stays disabled until the input exactly matches the phrase
- When not provided (existing callers), the modal works unchanged
app/project/[projectId]/settings/page.tsx — Passes confirmationPhrase={permanently delete ${project.name}} to the ConfirmModal. The user must type exactly e.g. permanently delete Heed to enable the delete button, which then sends DELETE /api/projects/{id} to the backend.