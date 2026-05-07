// Styly kategorií (barvy, emoji, výchozí limity)
export const CATEGORY_STYLE = {
  // Hlavní z patternů
  'Jídlo':                { color: '#D62828', emoji: '🛒', limit: 8000 },
  'Jídlo ven':            { color: '#F77F00', emoji: '🍽️', limit: 4000 },
  'Káva':                 { color: '#A0522D', emoji: '☕', limit: 1500 },
  'Doprava':              { color: '#06AED5', emoji: '🚇', limit: 1500 },
  'Auto':                 { color: '#2EC4B6', emoji: '🚗', limit: 4000 },
  'Bydlení':              { color: '#1B263B', emoji: '🏠', limit: 8000 },
  'Předplatné':           { color: '#9B5DE5', emoji: '💳', limit: 2500 },
  'Zábava':               { color: '#E71D36', emoji: '🎬', limit: 2000 },
  'Krása':                { color: '#FF8FA3', emoji: '💄', limit: 3000 },
  'Drogerie':             { color: '#06D6A0', emoji: '🧴', limit: 1500 },
  'Leošek':               { color: '#FFD23F', emoji: '👶', limit: 3000 },
  'Mazlíček':             { color: '#FFC857', emoji: '🐾', limit: 2000 },
  'Domov':                { color: '#5F0F40', emoji: '🛋️', limit: 3000 },
  'Oblečení':             { color: '#FF006E', emoji: '👗', limit: 2500 },
  'Nákupy':               { color: '#7209B7', emoji: '🛍️', limit: 3000 },
  'Sport':                { color: '#80B918', emoji: '🏃‍♀️', limit: 2000 },
  'Cestování':            { color: '#118AB2', emoji: '✈️', limit: 5000 },
  'Pojištění':            { color: '#3D5A80', emoji: '📄', limit: 3000 },
  'Půjčky':               { color: '#A4161A', emoji: '💸', limit: 1500 },
  'Telefon':              { color: '#00B4D8', emoji: '📱', limit: 1000 },
  // Účty / speciální
  'Školka':               { color: '#F72585', emoji: '🎒', limit: 18000 },
  'Charita':              { color: '#52B788', emoji: '❤️',  limit: 500 },
  'Výplata':              { color: '#06D6A0', emoji: '💰', limit: 0 },
  'Příjem':               { color: '#52B788', emoji: '💰', limit: 0 },
  'Převod':               { color: '#5C6B73', emoji: '🔄', limit: 0 },
  // Z PDF struktur
  'Bankovní poplatky':    { color: '#8D99AE', emoji: '🏦', limit: 200 },
  'Hotovost':             { color: '#A4161A', emoji: '💵', limit: 3000 },
  'Nezařazeno':           { color: '#6C757D', emoji: '❓', limit: 0 },
};

const fallbackColors = ['#F72585', '#7209B7', '#3A0CA3', '#4361EE', '#4CC9F0', '#80B918', '#FFC857', '#9B5DE5', '#06D6A0'];

export const styleFor = (cat, idx = 0) =>
  CATEGORY_STYLE[cat] || { color: fallbackColors[idx % fallbackColors.length], emoji: '📌', limit: 0 };

// Kategorie podle "Kategorie transakce" v PDF (Raiffka klasifikace)
export const RB_CATEGORIES = {
  'Poplatek': 'Bankovní poplatky',
  'Úrok': 'Bankovní poplatky',
  'Vklad/Výběr z bankomatu': 'Hotovost',
};

// Subscription detector
export const isSubscriptionMerchant = (note) => {
  const n = (note || '').toLowerCase();
  return ['netflix', 'spotify', 'apple.com/bill', 'youtube', 'hbo', 'adobe', 'anthropic', 'tv nova'].some(k => n.includes(k));
};
