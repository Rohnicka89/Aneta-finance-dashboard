import React, { useState, useEffect, useMemo, useRef } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, LineChart, Line, CartesianGrid, XAxis, YAxis, Legend } from 'recharts';
import { Upload, Settings, X, Skull, ChevronDown, ChevronUp, AlertTriangle, ArrowRightLeft, FileText, Trash2, RefreshCw, LogOut } from 'lucide-react';

import { extractPdfText, parseRaiffkaText } from '../lib/parser.js';
import { fetchCiselnik, categorize } from '../lib/ciselnik.js';
import { styleFor } from '../lib/categories.js';
import { getRoast, getCategoryRoast } from '../lib/roasts.js';
import * as api from '../lib/api.js';

export default function Dashboard({ onLogout }) {
  const [transactions, setTransactions] = useState([]);
  const [totalLimit, setTotalLimit] = useState(35000);
  const [categoryLimits, setCategoryLimits] = useState({});
  const [showSettings, setShowSettings] = useState(false);
  const [activeRoast, setActiveRoast] = useState(null);
  const [dismissedRoasts, setDismissedRoasts] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState('');
  const [parseError, setParseError] = useState(null);
  const [showSubs, setShowSubs] = useState(false);
  const [showTransfers, setShowTransfers] = useState(false);
  const [debugText, setDebugText] = useState('');
  const [showRawText, setShowRawText] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState(null);

  const [patterns, setPatterns] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [ciselnikLoading, setCiselnikLoading] = useState(false);
  const [ciselnikStatus, setCiselnikStatus] = useState('');
  const [ciselnikLastUpdate, setCiselnikLastUpdate] = useState(null);

  const fileInputRef = useRef(null);
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  // Load při startu
  useEffect(() => {
    (async () => {
      try {
        const txs = await api.fetchTransactions();
        if (Array.isArray(txs)) setTransactions(txs);
      } catch (e) { console.error(e); }
      try {
        const settings = await api.fetchSettings();
        if (settings.totalLimit) setTotalLimit(settings.totalLimit);
        if (settings.categoryLimits) setCategoryLimits(settings.categoryLimits);
      } catch (e) { console.error(e); }
      // Cached číselník
      const cisCache = localStorage.getItem('cache_ciselnik');
      if (cisCache) {
        try {
          const cis = JSON.parse(cisCache);
          setPatterns(cis.patterny || []);
          setAccounts(cis.ucty || []);
          setCiselnikLastUpdate(new Date(cis.timestamp));
        } catch (e) {}
      }
      setLoading(false);
      // Auto-fetch fresh číselník
      setTimeout(() => reloadCiselnik(true), 500);
    })();
  }, []);

  const reloadCiselnik = async (silent = false) => {
    setCiselnikLoading(true);
    if (!silent) setCiselnikStatus('⏳ Stahuji číselník z Google Sheets…');
    try {
      const data = await fetchCiselnik();
      setPatterns(data.patterny);
      setAccounts(data.ucty);
      if (Object.keys(data.limity).length > 0) {
        const newLimits = { ...categoryLimits, ...data.limity };
        setCategoryLimits(newLimits);
        await api.saveSettings({ totalLimit, categoryLimits: newLimits });
      }
      localStorage.setItem('cache_ciselnik', JSON.stringify({
        patterny: data.patterny,
        ucty: data.ucty,
        limity: data.limity,
        timestamp: Date.now()
      }));
      setCiselnikLastUpdate(new Date());
      const summary = `✓ Číselník: ${data.patterny.length} patternů, ${data.ucty.length} účtů, ${Object.keys(data.limity).length} limitů`;
      const errorPart = data.errors.length > 0 ? ` ⚠️ Chyby: ${data.errors.join(', ')}` : '';
      setCiselnikStatus(summary + errorPart);
      // Po načtení překategorizuj
      await recategorizeTransactions(data.patterny, data.ucty);
    } catch (e) {
      setCiselnikStatus(`❌ Chyba: ${e.message}`);
    }
    setCiselnikLoading(false);
  };

  const recategorizeTransactions = async (newPatterns, newAccounts) => {
    if (transactions.length === 0) return;
    const updated = transactions.map(t => {
      if (t.type === 'transfer') return t;
      const result = categorize(t.fullDescription + ' ' + (t.rbType || ''), t.rbCategory, t.accountNumber, newPatterns, newAccounts);
      const accMatch = t.accountNumber ? newAccounts.find(a => a.ucet === t.accountNumber) : null;
      let newType = t.type;
      let newMerchant = t.merchant;
      if (accMatch) {
        if (accMatch.typ === 'Převod') newType = 'transfer';
        else if (accMatch.typ === 'Příjem') newType = 'income';
        if (accMatch.nazev && (t.merchant === 'Bez popisu' || ['Příchozí úhrada', 'Odchozí okamžitá úhrada', 'Trvalý příkaz', 'Jednorázová úhrada'].includes(t.merchant))) {
          newMerchant = accMatch.nazev;
        }
      }
      let newCat = result.cat;
      if (newType === 'income') newCat = result.cat !== 'Nezařazeno' ? result.cat : 'Příjem';
      else if (newType === 'transfer') newCat = 'Převod';
      return { ...t, category: newCat, type: newType, merchant: newMerchant, categorySource: result.source };
    });
    setTransactions(updated);
    await api.saveTransactions(updated);
  };

  const monthTx = useMemo(() => transactions.filter(t => t.date.startsWith(selectedMonth)), [transactions, selectedMonth]);
  const expenses = useMemo(() => monthTx.filter(t => t.type === 'expense'), [monthTx]);
  const incomes = useMemo(() => monthTx.filter(t => t.type === 'income'), [monthTx]);
  const transfers = useMemo(() => monthTx.filter(t => t.type === 'transfer'), [monthTx]);

  const totalSpent = useMemo(() => expenses.reduce((s, t) => s + t.amount, 0), [expenses]);
  const totalIncome = useMemo(() => incomes.reduce((s, t) => s + t.amount, 0), [incomes]);
  const netBalance = totalIncome - totalSpent;
  const totalPercent = totalLimit > 0 ? (totalSpent / totalLimit) * 100 : 0;

  const categorySpending = useMemo(() => {
    const m = {};
    expenses.forEach(t => { m[t.category] = (m[t.category] || 0) + t.amount; });
    return m;
  }, [expenses]);

  const allCategories = useMemo(() => Array.from(new Set(expenses.map(t => t.category))).sort(), [expenses]);

  const subscriptions = useMemo(() => {
    const subs = expenses.filter(t => t.isSubscription || t.category === 'Předplatné');
    const grouped = {};
    subs.forEach(t => {
      const key = t.merchant.toLowerCase().replace(/\d+/g, '').replace(/[*\-_]/g, ' ').trim();
      if (!grouped[key]) grouped[key] = { name: t.merchant, total: 0, count: 0 };
      grouped[key].total += t.amount;
      grouped[key].count += 1;
    });
    return Object.values(grouped).sort((a, b) => b.total - a.total);
  }, [expenses]);

  const subsTotal = subscriptions.reduce((s, x) => s + x.total, 0);

  const categoryWarnings = useMemo(() => {
    return allCategories
      .map(cat => {
        const spent = categorySpending[cat] || 0;
        const limit = categoryLimits[cat];
        if (!limit || limit <= 0) return null;
        const pct = (spent / limit) * 100;
        if (pct < 75) return null;
        return { cat, pct, spent, limit, roast: getCategoryRoast(cat, limit) };
      })
      .filter(Boolean)
      .sort((a, b) => b.pct - a.pct);
  }, [allCategories, categorySpending, categoryLimits]);

  // Roast trigger
  useEffect(() => {
    if (loading || totalLimit === 0) return;
    let threshold = null;
    if (totalPercent >= 100) threshold = 100;
    else if (totalPercent >= 90) threshold = 90;
    else if (totalPercent >= 75) threshold = 75;
    else if (totalPercent >= 60) threshold = 60;
    if (!threshold) return;
    const key = `${selectedMonth}-${threshold}`;
    if (dismissedRoasts.has(key)) return;
    const r = getRoast(totalPercent);
    if (r) setActiveRoast({ text: r, key });
  }, [totalPercent, totalLimit, loading, selectedMonth]);

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setParseError('Nahraj prosím PDF soubor.');
      return;
    }
    setParsing(true);
    setParseError(null);
    setDebugText('');
    setParseStatus(`📄 ${file.name} (${Math.round(file.size/1024)} KB)`);

    try {
      setParseStatus('⏳ Krok 1/3: Čtu PDF…');
      await new Promise(r => setTimeout(r, 50));
      const text = await extractPdfText(file);
      setParseStatus(`⏳ Krok 2/3: Extrahováno ${text.length} znaků`);
      setDebugText(text);
      if (!text || text.length < 100) {
        const msg = `PDF má jen ${text.length} znaků - asi je to scan, ne text.`;
        setParseError(msg);
        setParseStatus('❌ ' + msg);
        setParsing(false);
        return;
      }
      setParseStatus('⏳ Krok 3/3: Parsuji transakce…');
      const newTx = parseRaiffkaText(text, patterns, accounts);
      if (newTx.length === 0) {
        setParseError('Žádné transakce nerozpoznány. Klikni na DEBUG.');
        setParseStatus('❌ Žádné transakce.');
        setParsing(false);
        return;
      }
      const existingIds = new Set(transactions.map(t => t.id));
      const newOnes = newTx.filter(t => !existingIds.has(t.id));
      const merged = [...transactions, ...newOnes];
      setTransactions(merged);
      await api.saveTransactions(merged);
      setParseStatus(`✅ Načteno ${newOnes.length} nových z ${newTx.length} celkem.`);
    } catch (err) {
      console.error(err);
      const msg = `Chyba: ${err.message || err.toString()}`;
      setParseError(msg);
      setParseStatus('❌ ' + msg);
    }
    setParsing(false);
    if (e.target) e.target.value = '';
  };

  const triggerFileSelect = () => fileInputRef.current?.click();

  const updateCategoryLimit = async (cat, value) => {
    const updated = { ...categoryLimits, [cat]: parseFloat(value) || 0 };
    setCategoryLimits(updated);
    await api.saveSettings({ totalLimit, categoryLimits: updated });
  };
  const updateTotalLimit = async (value) => {
    const v = parseFloat(value) || 0;
    setTotalLimit(v);
    await api.saveSettings({ totalLimit: v, categoryLimits });
  };
  const initDefaultLimits = async () => {
    const def = {};
    allCategories.forEach(c => {
      const st = styleFor(c);
      if (st.limit > 0) def[c] = st.limit;
    });
    const merged = { ...def, ...categoryLimits };
    setCategoryLimits(merged);
    await api.saveSettings({ totalLimit, categoryLimits: merged });
  };
  const clearAllData = async () => {
    if (!confirm('Opravdu smazat VŠECHNY transakce? Tuhle akci nelze vrátit.')) return;
    setTransactions([]);
    await api.deleteAllTransactions();
  };

  const dismissRoast = () => {
    if (activeRoast) setDismissedRoasts(new Set([...dismissedRoasts, activeRoast.key]));
    setActiveRoast(null);
  };

  const pieData = allCategories
    .map((c, i) => ({ name: c, value: categorySpending[c] || 0, color: styleFor(c, i).color }))
    .filter(d => d.value > 0)
    .sort((a, b) => b.value - a.value);

  const dailyData = useMemo(() => {
    const days = {};
    expenses.forEach(t => {
      const day = parseInt(t.date.split('-')[2]);
      days[day] = (days[day] || 0) + t.amount;
    });
    const [year, month] = selectedMonth.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    let cumulative = 0;
    return Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      cumulative += days[day] || 0;
      return { day, denně: days[day] || 0, kumulativně: cumulative };
    });
  }, [expenses, selectedMonth]);

  const availableMonths = useMemo(() => {
    const months = new Set(transactions.map(t => t.date.substring(0, 7)));
    months.add(selectedMonth);
    return Array.from(months).sort().reverse();
  }, [transactions, selectedMonth]);

  if (loading) {
    return <div style={{ minHeight: '100dvh', background: '#0F0F0E', color: '#EAE3D2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Načítám…</div>;
  }

  return (
    <div style={{ minHeight: '100dvh', background: '#0F0F0E', color: '#EAE3D2', padding: '24px' }}>
      {/* Roast Modal */}
      {activeRoast && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.92)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div className="shake" style={{ background: '#D62828', color: '#FAF7F2', maxWidth: '560px', padding: '48px 40px', border: '4px solid #0F0F0E', boxShadow: '12px 12px 0 #0F0F0E' }}>
            <Skull size={56} style={{ marginBottom: '20px' }} />
            <div className="mono" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '5px', marginBottom: '16px', opacity: 0.85 }}>
              Notifikace · {totalPercent.toFixed(0)} % limitu
            </div>
            <div className="display" style={{ fontSize: '32px', fontWeight: 700, lineHeight: 1.15, marginBottom: '32px' }}>
              {activeRoast.text}
            </div>
            <button onClick={dismissRoast} style={{ background: '#0F0F0E', color: '#FAF7F2', padding: '16px 32px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '2px', fontSize: '12px' }}>
              Beru na vědomí ✓
            </button>
          </div>
        </div>
      )}

      <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
        {/* Header */}
        <header style={{ marginBottom: '40px', borderBottom: '3px solid #EAE3D2', paddingBottom: '20px' }}>
          <div className="mono" style={{ fontSize: '11px', letterSpacing: '4px', marginBottom: '8px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', color: '#E5B73B' }}>
            <span>RAIFFEISENBANK · OSOBNÍ DASHBOARD</span>
            <span>{new Date().toLocaleDateString('cs-CZ')}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap' }}>
            <h1 className="display" style={{ margin: 0, fontSize: 'clamp(40px, 8vw, 96px)', fontWeight: 600, letterSpacing: '-3px', lineHeight: 0.9 }}>
              Kam to <em style={{ color: '#E5B73B', fontStyle: 'italic', fontWeight: 700 }}>mizí</em>,<br/>Aneto?
            </h1>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" onChange={handleFileUpload} style={{ position: 'absolute', left: '-9999px' }} />
              <button onClick={triggerFileSelect} disabled={parsing} style={{ background: '#E5B73B', color: '#0F0F0E', padding: '14px 22px', display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', fontSize: '12px', opacity: parsing ? 0.7 : 1 }}>
                <Upload size={16} />
                {parsing ? 'Parsuji…' : 'Nahrát PDF'}
              </button>
              <button onClick={() => reloadCiselnik(false)} disabled={ciselnikLoading} title="Načíst číselník" style={{ background: 'transparent', color: '#9B5DE5', padding: '14px', border: '2px solid #9B5DE5', display: 'inline-flex', alignItems: 'center', opacity: ciselnikLoading ? 0.6 : 1 }}>
                <RefreshCw size={16} className={ciselnikLoading ? '' : ''} />
              </button>
              <button onClick={() => setShowSettings(!showSettings)} style={{ background: 'transparent', color: '#EAE3D2', padding: '14px', border: '2px solid #EAE3D2' }}>
                <Settings size={16} />
              </button>
              <button onClick={onLogout} title="Odhlásit" style={{ background: 'transparent', color: '#8A8377', padding: '14px', border: '2px solid #2A2622' }}>
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </header>

        {/* Číselník status */}
        {(ciselnikStatus || patterns.length > 0) && (
          <div style={{
            background: ciselnikStatus.startsWith('❌') ? '#D62828' : '#1A1816',
            color: '#EAE3D2',
            padding: '12px 18px', marginBottom: '16px',
            border: `1px solid ${ciselnikStatus.startsWith('❌') ? '#D62828' : '#9B5DE5'}`,
            display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px',
            fontFamily: 'JetBrains Mono, monospace',
            flexWrap: 'wrap'
          }}>
            <span style={{ flex: 1 }}>
              {ciselnikStatus || `📋 Číselník: ${patterns.length} patternů, ${accounts.length} účtů (cached)`}
            </span>
            {ciselnikLastUpdate && (
              <span style={{ opacity: 0.6, fontSize: '11px' }}>
                {ciselnikLastUpdate.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        )}

        {/* Parse status */}
        {(parsing || parseStatus) && (
          <div style={{
            background: parseStatus.startsWith('❌') ? '#D62828' : parseStatus.startsWith('✅') ? '#80B918' : '#E5B73B',
            color: parseStatus.startsWith('❌') ? '#FAF7F2' : '#0F0F0E',
            padding: '14px 20px', marginBottom: '16px',
            display: 'flex', alignItems: 'center', gap: '12px', fontWeight: 600, fontSize: '13px'
          }}>
            <span>{parseStatus || '⏳'}</span>
          </div>
        )}

        {parseError && (
          <div style={{ background: '#D62828', color: '#fff', padding: '16px 20px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <AlertTriangle size={20} />
            <div style={{ flex: 1, fontSize: '13px' }}>{parseError}</div>
            {debugText && <button onClick={() => setShowRawText(!showRawText)} style={{ background: '#fff', color: '#D62828', padding: '6px 12px', fontWeight: 700, fontSize: '11px' }}>Debug</button>}
          </div>
        )}
        {showRawText && debugText && (
          <pre style={{ background: '#0a0a0a', color: '#80B918', padding: '16px', marginBottom: '24px', maxHeight: '300px', overflow: 'auto', fontSize: '11px', whiteSpace: 'pre-wrap' }}>
            {debugText.substring(0, 5000)}
          </pre>
        )}

        {/* Months */}
        {availableMonths.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', marginBottom: '32px', flexWrap: 'wrap' }}>
            {availableMonths.map(m => (
              <button key={m} onClick={() => setSelectedMonth(m)} className="mono" style={{
                background: m === selectedMonth ? '#EAE3D2' : 'transparent',
                color: m === selectedMonth ? '#0F0F0E' : '#EAE3D2',
                border: '1.5px solid #EAE3D2', padding: '8px 16px',
                fontSize: '11px', fontWeight: 600, letterSpacing: '1.5px', textTransform: 'uppercase'
              }}>
                {new Date(m + '-01').toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })}
              </button>
            ))}
          </div>
        )}

        {/* Settings */}
        {showSettings && (
          <div className="card" style={{ padding: '32px', marginBottom: '32px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h2 className="display" style={{ margin: 0, fontSize: '32px', fontWeight: 600 }}>Nastavení</h2>
              <button onClick={() => setShowSettings(false)} style={{ color: '#EAE3D2' }}><X size={20} /></button>
            </div>
            <div style={{ marginBottom: '32px', paddingBottom: '24px', borderBottom: '1px solid #2A2622' }}>
              <label className="mono" style={{ fontSize: '11px', letterSpacing: '2px', display: 'block', marginBottom: '10px', textTransform: 'uppercase', color: '#E5B73B' }}>
                Celkový měsíční limit (Kč)
              </label>
              <input type="number" value={totalLimit} onChange={(e) => updateTotalLimit(e.target.value)}
                className="display" style={{ background: '#0F0F0E', color: '#EAE3D2', border: '2px solid #2A2622', padding: '14px 18px', fontSize: '36px', fontWeight: 600, width: '320px', maxWidth: '100%' }} />
            </div>
            {allCategories.length > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
                  <div className="mono" style={{ fontSize: '11px', letterSpacing: '2px', textTransform: 'uppercase', color: '#E5B73B' }}>
                    Limity kategorií ({allCategories.length})
                  </div>
                  <button onClick={initDefaultLimits} style={{ background: '#E5B73B', color: '#0F0F0E', padding: '10px 16px', fontWeight: 700, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                    Nastav výchozí
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px', marginBottom: '24px' }}>
                  {allCategories.map((cat, i) => {
                    const st = styleFor(cat, i);
                    return (
                      <div key={cat} style={{ background: '#0F0F0E', border: '1px solid #2A2622', padding: '14px', borderLeft: `5px solid ${st.color}` }}>
                        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>
                          {st.emoji} {cat}
                        </div>
                        <input type="number" placeholder="Limit (Kč)" value={categoryLimits[cat] || ''}
                          onChange={(e) => updateCategoryLimit(cat, e.target.value)}
                          className="mono" style={{ background: '#1A1816', color: '#EAE3D2', border: '1px solid #2A2622', padding: '8px 10px', width: '100%', fontSize: '13px' }} />
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <button onClick={clearAllData} style={{ background: 'transparent', color: '#D62828', border: '2px solid #D62828', padding: '12px 20px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <Trash2 size={14} /> Smazat všechna data
            </button>
          </div>
        )}

        {/* Empty state */}
        {transactions.length === 0 ? (
          <div className="card" style={{ padding: '80px 32px', textAlign: 'center' }}>
            <FileText size={64} style={{ marginBottom: '20px', opacity: 0.4 }} />
            <h2 className="display" style={{ fontSize: '40px', marginBottom: '12px', fontWeight: 600 }}>Začni nahráním PDF výpisu</h2>
            <p style={{ color: '#8A8377', maxWidth: '480px', margin: '0 auto', lineHeight: 1.7, fontSize: '14px' }}>
              V Raiffka iBankingu otevři <strong style={{ color: '#EAE3D2' }}>Účty → Výpisy</strong> nebo si počkej na denní výpis emailem.<br/>
              Pak nahoře klikni na <strong style={{ color: '#E5B73B' }}>NAHRÁT PDF</strong>.
            </p>
          </div>
        ) : (
          <>
            {/* Hero stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px', marginBottom: '12px' }}>
              <div className={totalPercent >= 100 ? 'pulse-danger' : ''} style={{
                background: totalPercent >= 90 ? '#D62828' : '#1A1816', color: '#EAE3D2',
                padding: '32px', minHeight: '180px', border: totalPercent >= 90 ? 'none' : '1px solid #2A2622'
              }}>
                <div className="mono" style={{ fontSize: '10px', letterSpacing: '3px', marginBottom: '10px', textTransform: 'uppercase', opacity: 0.6 }}>
                  Výdaje · tento měsíc
                </div>
                <div className="display" style={{ fontSize: 'clamp(40px, 5.5vw, 72px)', fontWeight: 600, lineHeight: 1, letterSpacing: '-2.5px' }}>
                  {totalSpent.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })}
                </div>
                <div className="mono" style={{ fontSize: '14px', marginTop: '8px', opacity: 0.6 }}>Kč</div>
                <div className="mono" style={{ fontSize: '11px', marginTop: '20px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                  z {totalLimit.toLocaleString('cs-CZ')} Kč · <strong>{totalPercent.toFixed(1)} %</strong>
                </div>
                <div style={{ marginTop: '10px', height: '4px', background: 'rgba(234,227,210,0.15)' }}>
                  <div style={{ width: `${Math.min(totalPercent, 100)}%`, height: '100%', background: totalPercent >= 90 ? '#EAE3D2' : '#E5B73B', transition: 'width 0.5s' }} />
                </div>
              </div>
              <div style={{ background: '#1A1816', border: '1px solid #2A2622', padding: '32px', minHeight: '180px' }}>
                <div className="mono" style={{ fontSize: '10px', letterSpacing: '3px', marginBottom: '10px', textTransform: 'uppercase', color: '#8A8377' }}>
                  Příjmy · tento měsíc
                </div>
                <div className="display" style={{ fontSize: 'clamp(40px, 5.5vw, 72px)', fontWeight: 600, lineHeight: 1, color: '#80B918', letterSpacing: '-2.5px' }}>
                  {totalIncome.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })}
                </div>
                <div className="mono" style={{ fontSize: '14px', marginTop: '8px', color: '#8A8377' }}>Kč</div>
                <div className="mono" style={{ fontSize: '11px', marginTop: '20px', color: '#8A8377', textTransform: 'uppercase', letterSpacing: '1px' }}>
                  {incomes.length} {incomes.length === 1 ? 'příjem' : incomes.length < 5 ? 'příjmy' : 'příjmů'}
                </div>
              </div>
              <div style={{ background: netBalance >= 0 ? '#80B918' : '#D62828', color: '#0F0F0E', padding: '32px', minHeight: '180px' }}>
                <div className="mono" style={{ fontSize: '10px', letterSpacing: '3px', marginBottom: '10px', textTransform: 'uppercase', opacity: 0.7, color: netBalance >= 0 ? '#0F0F0E' : '#FAF7F2' }}>
                  Bilance · příjmy − výdaje
                </div>
                <div className="display" style={{ fontSize: 'clamp(38px, 5vw, 64px)', fontWeight: 600, lineHeight: 1, letterSpacing: '-2px', color: netBalance >= 0 ? '#0F0F0E' : '#FAF7F2' }}>
                  {netBalance >= 0 ? '+' : ''}{netBalance.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })}
                </div>
                <div className="mono" style={{ fontSize: '14px', marginTop: '8px', opacity: 0.7, color: netBalance >= 0 ? '#0F0F0E' : '#FAF7F2' }}>Kč</div>
                <div className="mono" style={{ fontSize: '11px', marginTop: '20px', textTransform: 'uppercase', letterSpacing: '1px', color: netBalance >= 0 ? '#0F0F0E' : '#FAF7F2' }}>
                  {netBalance >= 0 ? '✓ V plusu' : '⚠ V mínusu'}
                </div>
              </div>
            </div>

            {/* Category warnings */}
            {categoryWarnings.length > 0 && (
              <div style={{ display: 'grid', gap: '8px', marginBottom: '12px' }}>
                {categoryWarnings.map(w => (
                  <div key={w.cat} className="slide-up" style={{
                    background: w.pct >= 100 ? '#D62828' : '#F77F00', color: '#fff',
                    padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px'
                  }}>
                    <AlertTriangle size={22} style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div className="mono" style={{ fontWeight: 800, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px', opacity: 0.9 }}>
                        {w.cat} · {w.pct.toFixed(0)} % · {w.spent.toLocaleString('cs-CZ')}/{w.limit.toLocaleString('cs-CZ')} Kč
                      </div>
                      <div className="display" style={{ fontSize: '17px', lineHeight: 1.35, fontWeight: 500 }}>
                        {w.roast}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Charts */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '12px', marginTop: '24px', marginBottom: '12px' }}>
              <div className="card" style={{ padding: '28px' }}>
                <h3 className="display" style={{ margin: '0 0 20px', fontSize: '24px', fontWeight: 600 }}>Útraty podle kategorií</h3>
                {pieData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={110} label={(e) => e.percent > 0.05 ? `${(e.percent * 100).toFixed(0)}%` : ''} labelLine={false}>
                        {pieData.map((entry, i) => <Cell key={i} fill={entry.color} stroke="#0F0F0E" strokeWidth={2} />)}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: '#1A1816', border: '1px solid #E5B73B', color: '#EAE3D2', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                        itemStyle={{ color: '#EAE3D2' }}
                        labelStyle={{ color: '#E5B73B', fontWeight: 700 }}
                        formatter={(v, name) => [`${v.toLocaleString('cs-CZ')} Kč`, name]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A8377' }}>Žádné útraty</div>}
              </div>
              <div className="card" style={{ padding: '28px' }}>
                <h3 className="display" style={{ margin: '0 0 20px', fontSize: '24px', fontWeight: 600 }}>Průběh měsíce</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={dailyData} margin={{ left: -10 }}>
                    <CartesianGrid stroke="#2A2622" strokeDasharray="2 4" />
                    <XAxis dataKey="day" stroke="#8A8377" tick={{ fontSize: 11, fill: '#8A8377' }} />
                    <YAxis stroke="#8A8377" tick={{ fontSize: 11, fill: '#8A8377' }} />
                    <Tooltip
                      contentStyle={{ background: '#1A1816', border: '1px solid #E5B73B', color: '#EAE3D2', fontSize: '12px' }}
                      itemStyle={{ color: '#EAE3D2' }}
                      labelStyle={{ color: '#E5B73B', fontWeight: 700 }}
                      formatter={(v) => `${v.toLocaleString('cs-CZ')} Kč`}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px', textTransform: 'uppercase' }} />
                    <Line type="monotone" dataKey="kumulativně" stroke="#E5B73B" strokeWidth={3} dot={false} />
                    {totalLimit > 0 && <Line type="monotone" dataKey={() => totalLimit} stroke="#D62828" strokeDasharray="6 4" dot={false} name="Limit" />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Subscriptions */}
            {subscriptions.length > 0 && (
              <div className="card" style={{ marginBottom: '12px' }}>
                <button onClick={() => setShowSubs(!showSubs)} style={{ width: '100%', padding: '24px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left', color: '#EAE3D2' }}>
                  <div>
                    <div className="mono" style={{ fontSize: '11px', letterSpacing: '3px', color: '#9B5DE5', marginBottom: '4px', textTransform: 'uppercase' }}>
                      💳 Předplatné
                    </div>
                    <h3 className="display" style={{ margin: 0, fontSize: '26px', fontWeight: 600 }}>
                      {subscriptions.length} služeb · {subsTotal.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} Kč
                    </h3>
                  </div>
                  {showSubs ? <ChevronUp size={24} /> : <ChevronDown size={24} />}
                </button>
                {showSubs && (
                  <div style={{ padding: '0 28px 28px' }}>
                    <div style={{ display: 'grid', gap: '6px' }}>
                      {subscriptions.map((s, i) => (
                        <div key={i} style={{ background: '#0F0F0E', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderLeft: '4px solid #9B5DE5' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '14px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                            <div className="mono" style={{ fontSize: '11px', color: '#8A8377', marginTop: '2px' }}>
                              {s.count}× tento měsíc
                            </div>
                          </div>
                          <div className="display" style={{ fontSize: '22px', fontWeight: 600 }}>
                            {s.total.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} Kč
                          </div>
                        </div>
                      ))}
                    </div>
                    {subsTotal > 2000 && (
                      <div style={{ marginTop: '16px', padding: '14px 18px', background: '#9B5DE5', color: '#fff', fontSize: '13px', lineHeight: 1.5 }}>
                        💀 <strong>{subsTotal.toLocaleString('cs-CZ')} Kč</strong> jen na předplatném tento měsíc. To je <strong>{(subsTotal * 12).toLocaleString('cs-CZ')} Kč ročně</strong>.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Transfers */}
            {transfers.length > 0 && (
              <div className="card" style={{ marginBottom: '12px' }}>
                <button onClick={() => setShowTransfers(!showTransfers)} style={{ width: '100%', padding: '24px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left', color: '#EAE3D2' }}>
                  <div>
                    <div className="mono" style={{ fontSize: '11px', letterSpacing: '3px', color: '#06AED5', marginBottom: '4px', textTransform: 'uppercase' }}>
                      🔄 Převody mezi účty
                    </div>
                    <h3 className="display" style={{ margin: 0, fontSize: '26px', fontWeight: 600 }}>
                      {transfers.length} převodů · nezapočítáno
                    </h3>
                  </div>
                  {showTransfers ? <ChevronUp size={24} /> : <ChevronDown size={24} />}
                </button>
                {showTransfers && (
                  <div style={{ padding: '0 28px 28px' }}>
                    {transfers.map(t => (
                      <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #2A2622', gap: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                          <ArrowRightLeft size={16} color="#06AED5" />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.merchant}</div>
                            <div className="mono" style={{ fontSize: '11px', color: '#8A8377' }}>{t.date} · {t.rbType}</div>
                          </div>
                        </div>
                        <div className="display" style={{ fontSize: '18px', fontWeight: 600 }}>
                          {t.isPositive ? '+' : '−'}{t.amount.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} Kč
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Categories */}
            <div className="card" style={{ padding: '28px', marginBottom: '12px' }}>
              <h3 className="display" style={{ margin: '0 0 8px', fontSize: '28px', fontWeight: 600 }}>Kategorie & limity</h3>
              <div className="mono" style={{ fontSize: '11px', color: '#8A8377', marginBottom: '20px', textTransform: 'uppercase', letterSpacing: '1.5px' }}>
                Klikni na kategorii pro detail transakcí
              </div>
              <div style={{ display: 'grid', gap: '8px' }}>
                {allCategories.map((cat, i) => {
                  const st = styleFor(cat, i);
                  const spent = categorySpending[cat] || 0;
                  const limit = categoryLimits[cat] || 0;
                  const pct = limit > 0 ? (spent / limit) * 100 : 0;
                  const danger = pct >= 90;
                  const warning = pct >= 75;
                  const isExpanded = expandedCategory === cat;
                  // Transakce této kategorie, seřazené od největší
                  const catTransactions = expenses
                    .filter(t => t.category === cat)
                    .sort((a, b) => b.amount - a.amount);

                  return (
                    <div key={cat} style={{ background: '#0F0F0E', borderLeft: `6px solid ${st.color}`, border: '1px solid #2A2622', overflow: 'hidden' }}>
                      <button
                        onClick={() => setExpandedCategory(isExpanded ? null : cat)}
                        style={{
                          width: '100%',
                          padding: '14px 18px',
                          background: 'transparent',
                          color: '#EAE3D2',
                          textAlign: 'left',
                          cursor: 'pointer',
                          display: 'block'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px', flexWrap: 'wrap', gap: '8px' }}>
                          <div className="display" style={{ fontSize: '18px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {st.emoji} {cat}
                            {danger && <AlertTriangle size={14} style={{ color: '#D62828' }} />}
                            <span className="mono" style={{ fontSize: '11px', color: '#8A8377', fontWeight: 400, marginLeft: '4px' }}>
                              ({catTransactions.length} {catTransactions.length === 1 ? 'položka' : catTransactions.length < 5 ? 'položky' : 'položek'})
                            </span>
                            {isExpanded ? <ChevronUp size={16} style={{ color: '#8A8377' }} /> : <ChevronDown size={16} style={{ color: '#8A8377' }} />}
                          </div>
                          <div className="mono" style={{ fontSize: '12px' }}>
                            <strong style={{ color: danger ? '#D62828' : warning ? '#F77F00' : '#EAE3D2', fontSize: '14px' }}>
                              {spent.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} Kč
                            </strong>
                            {limit > 0 ? <span style={{ color: '#8A8377' }}> / {limit.toLocaleString('cs-CZ')} Kč ({pct.toFixed(0)} %)</span> : <span style={{ color: '#8A8377' }}> · bez limitu</span>}
                          </div>
                        </div>
                        {limit > 0 && (
                          <div style={{ height: '4px', background: '#2A2622' }}>
                            <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: danger ? '#D62828' : warning ? '#F77F00' : st.color, transition: 'width 0.5s' }} />
                          </div>
                        )}
                      </button>

                      {/* Rozbalený seznam transakcí */}
                      {isExpanded && (
                        <div className="slide-up" style={{ padding: '4px 18px 18px', borderTop: '1px solid #2A2622', background: '#0a0a09' }}>
                          {catTransactions.length === 0 ? (
                            <div style={{ padding: '14px 0', color: '#8A8377', fontSize: '13px', fontStyle: 'italic' }}>
                              Žádné transakce v této kategorii.
                            </div>
                          ) : (
                            <div>
                              {catTransactions.map(t => (
                                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #1f1d1a', gap: '12px' }}>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {t.merchant}
                                    </div>
                                    <div className="mono" style={{ fontSize: '10px', color: '#8A8377', marginTop: '2px' }}>
                                      {t.date}{t.rbType ? ' · ' + t.rbType : ''}{t.accountNumber ? ' · ' + t.accountNumber : ''}
                                    </div>
                                  </div>
                                  <div className="display" style={{ fontSize: '16px', fontWeight: 600, flexShrink: 0 }}>
                                    −{t.amount.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} Kč
                                  </div>
                                </div>
                              ))}
                              <div className="mono" style={{ paddingTop: '12px', textAlign: 'right', fontSize: '11px', color: '#8A8377', textTransform: 'uppercase', letterSpacing: '1px' }}>
                                Celkem: <strong style={{ color: '#EAE3D2', fontSize: '13px' }}>
                                  {spent.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} Kč
                                </strong>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Recent transactions */}
            <div className="card" style={{ padding: '28px' }}>
              <h3 className="display" style={{ margin: '0 0 20px', fontSize: '28px', fontWeight: 600 }}>Poslední transakce</h3>
              <div style={{ maxHeight: '500px', overflowY: 'auto' }}>
                {expenses.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60).map(t => {
                  const st = styleFor(t.category);
                  return (
                    <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #2A2622', gap: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
                        <div style={{ width: '6px', height: '40px', background: st.color, flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '14px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.merchant}</div>
                          <div className="mono" style={{ fontSize: '11px', color: '#8A8377', marginTop: '2px' }}>{t.date} · {st.emoji} {t.category}</div>
                        </div>
                      </div>
                      <div className="display" style={{ fontSize: '20px', fontWeight: 600 }}>
                        −{t.amount.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} Kč
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        <footer className="mono" style={{ marginTop: '64px', paddingTop: '24px', borderTop: '2px solid #2A2622', fontSize: '10px', color: '#8A8377', letterSpacing: '2.5px', textAlign: 'center', textTransform: 'uppercase' }}>
          Raiffka PDF · Cloudflare D1 · PWA
        </footer>
      </div>
    </div>
  );
}
