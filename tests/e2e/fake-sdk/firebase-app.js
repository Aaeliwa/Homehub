// TEST DOUBLE for https://www.gstatic.com/firebasejs/<v>/firebase-app.js (browser E2E only).
export function initializeApp(config) {
  if (!config || !config.projectId) throw new Error('fake: missing config');
  return { name: '[DEFAULT]', options: config };
}
