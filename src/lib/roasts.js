// =============================================================================
// Peprné notifikace při překročení limitu
// =============================================================================

export const ROAST_LEVELS = {
  60: [
    "Hej, 60 % limitu už je fuč. Zbytek měsíce ti bude bolet, kámo.",
    "60 %. Pomalu si připrav výmluvy, proč zase nezbylo na spoření.",
    "Tak jsme na 60 %. To není konec světa, ale ty peníze samy nepřibydou."
  ],
  75: [
    "75 %. Vážně? KAŽDÁ koruna od teď bolí. Zavři Wolt.",
    "Tři čtvrtiny rozpočtu pryč. Zbytek měsíce ti přeju hodně štěstí.",
    "75 %. Žabka není nutnost, je to volba. Pamatuj si to."
  ],
  90: [
    "DEVADESÁT PROCENT. Aneto, do prdele, co to vyvádíš? Zavři peněženku.",
    "90 %. Tohle už není utrácení, tohle je sebepoškozování. STOP.",
    "Devadesátka. Ještě jedna platba a můžeš si gratulovat k bankrotu měsíce."
  ],
  100: [
    "🚨 LIMIT PŘEKROČEN. Gratuluju, právě sis dokázala, že rozpočet je jen pro slabochy. 🚨",
    "💀 Limit fuč. Příští měsíc začínáš v záporu, ty finanční teroristko. 💀",
    "🔥 100 %+. Polož kartu a běž se projít. Nebo si dej rohlík s máslem doma."
  ]
};

export const CATEGORY_ROAST = {
  'Jídlo ven': "Wolt, McDonald, Klášterní sýpka… Doma máš sporák, pamatuješ?",
  'Jídlo': "Žabka už zase? Ty drahý drobky tě sežerou.",
  'Káva': "Cukrárna Mučenka už zase? Káva doma je o 80 % levnější.",
  'Předplatné': "Subscription apokalypsa. Někdo fakt potřebuje 6 streamovacích služeb?",
  'Zábava': "Zábava nad limit. Knihy z knihovny jsou taky zábava. A zdarma.",
  'Nákupy': "Nákupy nad rozpočet. Ten košík v Alze se sám nesmaže – ale ty to zvládneš.",
  'Mazlíček': "Tvůj mazlíček má lepší dietu než ty. Zooplus tě rozhodí víc než vlastní jídlo.",
  'Krása': "Salon, kadeřnictví, nehty… To je hezké. Ale pravidelný obličej je důležitější než pravidelná manikúra."
};

export const getRoast = (percent) => {
  let lvl = null;
  if (percent >= 100) lvl = 100;
  else if (percent >= 90) lvl = 90;
  else if (percent >= 75) lvl = 75;
  else if (percent >= 60) lvl = 60;
  if (!lvl) return null;
  const arr = ROAST_LEVELS[lvl];
  return arr[Math.floor(Math.random() * arr.length)];
};

export const getCategoryRoast = (cat, limit) => {
  return CATEGORY_ROAST[cat] || `${cat} jede nad rámec. Limit ${limit.toLocaleString('cs-CZ')} Kč už křičí.`;
};
