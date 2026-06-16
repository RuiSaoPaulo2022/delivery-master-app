/**
 * permission.js - Multi-tenant Permission Utilities
 * Shared across all modules for consistent RBAC enforcement.
 */

// ===== User Helpers =====
function getCurrentUser() {
  try {
    var raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function hasPermission(user, perm) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (user.permissions || []).indexOf(perm) !== -1;
}

function canWrite(user, modulePerm) {
  // silver is always read-only
  // gold: only write on specific modules they have access to
  // diamond: full write on all visible modules
  // admin: full write on everything
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'diamond') return true;
  if (user.role === 'gold') return hasPermission(user, modulePerm);
  return false; // silver
}

// ===== Project Filter =====
// Filters a projects array (from projects.json) based on user's allowedProjects.
// If user is admin, returns all projects.
// Otherwise, returns only projects whose 'name' is in allowedProjects.
function filterProjects(user, allProjects) {
  if (!user || user.role === 'admin') return allProjects;
  if (!user.allowedProjects || user.allowedProjects.length === 0) return [];

  return allProjects.filter(function(p) {
    return user.allowedProjects.indexOf(p.name) !== -1;
  });
}

// ===== UI Helpers =====
// Show/hide element by permission
function applyPermission(el, show) {
  if (!el) return;
  el.style.display = show ? '' : 'none';
}

// Apply write permissions to action buttons (new/create/edit/delete)
function applyWriteButtons(user, modulePerm) {
  var writable = canWrite(user, modulePerm);
  // Hide all elements with data-permission="write"
  var writeEls = document.querySelectorAll('[data-permission="write"]');
  for (var i = 0; i < writeEls.length; i++) {
    writeEls[i].style.display = writable ? '' : 'none';
  }
  // Hide all elements with class "td-delete-permission"
  var deleteTds = document.querySelectorAll('.td-delete-permission');
  for (var k = 0; k < deleteTds.length; k++) {
    deleteTds[k].style.display = writable ? '' : 'none';
  }
  // Handle contenteditable elements
  var editableEls = document.querySelectorAll('[contenteditable]');
  for (var j = 0; j < editableEls.length; j++) {
    if (writable) {
      editableEls[j].setAttribute('contenteditable', 'true');
      editableEls[j].style.backgroundColor = '';
      editableEls[j].style.cursor = '';
    } else {
      editableEls[j].setAttribute('contenteditable', 'false');
      editableEls[j].style.backgroundColor = '#f5f5f5';
      editableEls[j].style.cursor = 'not-allowed';
    }
  }
}
