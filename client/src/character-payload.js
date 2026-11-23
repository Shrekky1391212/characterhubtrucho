export function characterTagsToForm(tags) {
  return Array.isArray(tags) ? tags.join(', ') : String(tags ?? '');
}

export function characterTagsToApi(tags) {
  return characterTagsToForm(tags);
}