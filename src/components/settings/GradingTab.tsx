import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Award, 
  Save, 
  Plus, 
  Trash2, 
  Edit3, 
  X, 
  CheckCircle2, 
  ChevronRight, 
  MessageSquareText, 
  Loader2,
  AlertTriangle,
  ChevronDown,
  Check,
  Sparkles,
  UserRound
} from 'lucide-react';
import { db, auth } from "../../lib/firebase"; 
import { doc, getDoc, setDoc } from 'firebase/firestore';
import {
  insertTextAtSelection,
  normalizeRemarksMap,
  serializeRemarksMap,
  type PersonalizedRemarkVariable,
  type RatingLevel,
} from '../../lib/personalizedRemark';

export interface RatingPriority {
  level: 'Excellent' | 'Good' | 'Average' | 'Poor';
  score?: number;
  color: string;
  bgColor: string;
  borderColor?: string;
  badgeText: string;
}

export interface RemarkPreset {
  id: string;
  category: 'Homework' | 'Behavior' | 'Participation' | 'Performance' | 'Remarks';
  remarkText: string;
  source?: 'admin' | 'teacher';
}

interface GradingTabProps {
  userId?: string;
  ratingPriorities?: RatingPriority[];
  setRatingPriorities?: React.Dispatch<React.SetStateAction<RatingPriority[]>>;
}

const ALL_CATEGORIES: RemarkPreset['category'][] = [
  'Homework',
  'Behavior',
  'Participation',
  'Performance',
  'Remarks'
];

const DEFAULT_RATING_PRIORITIES: RatingPriority[] = [
  {
    level: 'Excellent',
    color: 'text-emerald-600 dark:text-emerald-400',
    bgColor: 'bg-emerald-50/70 dark:bg-emerald-950/20',
    borderColor: 'border-emerald-200/80 dark:border-emerald-800/60',
    badgeText: 'Top Performer',
  },
  {
    level: 'Good',
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-50/70 dark:bg-blue-950/20',
    borderColor: 'border-blue-200/80 dark:border-blue-800/60',
    badgeText: 'Above Average',
  },
  {
    level: 'Average',
    color: 'text-amber-600 dark:text-amber-400',
    bgColor: 'bg-amber-50/70 dark:bg-amber-950/20',
    borderColor: 'border-amber-200/80 dark:border-amber-800/60',
    badgeText: 'Needs Consistency',
  },
  {
    level: 'Poor',
    color: 'text-rose-600 dark:text-rose-400',
    bgColor: 'bg-rose-50/70 dark:bg-rose-950/20',
    borderColor: 'border-rose-200/80 dark:border-rose-800/60',
    badgeText: 'Requires Attention',
  },
];

type AdminAutoFillPresets = Record<RatingLevel, Record<RemarkPreset['category'], string>>;
type CentralAutoFillPresets = { presets: AdminAutoFillPresets; legacyDefaults: AdminAutoFillPresets };

const normalizeAutoFillPresets = (value: unknown): AdminAutoFillPresets => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The central grading presets response is invalid.');
  }
  const source = value as Record<string, unknown>;
  const result = {} as AdminAutoFillPresets;
  (['Excellent', 'Good', 'Average', 'Poor'] as RatingLevel[]).forEach((level) => {
    const levelValue = source[level];
    if (!levelValue || typeof levelValue !== 'object' || Array.isArray(levelValue)) {
      throw new Error(`The central ${level} presets are missing.`);
    }
    const categorySource = levelValue as Record<string, unknown>;
    const normalizedLevel = {} as Record<RemarkPreset['category'], string>;
    ALL_CATEGORIES.forEach((category) => {
      const text = categorySource[category];
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`The central ${level} / ${category} remark is missing.`);
      }
      normalizedLevel[category] = text.trim();
    });
    result[level] = normalizedLevel;
  });
  return result;
};

const fetchCentralAutoFillPresets = async (): Promise<CentralAutoFillPresets> => {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('Your teacher session is not ready. Please sign in again.');
  const token = await currentUser.getIdToken();
  const response = await fetch('/api/teacher/grading-presets', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  const payload = await response.json() as { success?: boolean; presets?: unknown; legacyDefaults?: unknown; error?: string };
  if (!response.ok || payload.success !== true) {
    throw new Error(payload.error || 'Central grading presets could not be loaded.');
  }
  return {
    presets: normalizeAutoFillPresets(payload.presets),
    legacyDefaults: normalizeAutoFillPresets(payload.legacyDefaults),
  };
};

const getCategoryStyles = (category: RemarkPreset['category']) => {
  switch (category) {
    case 'Homework':
      return {
        badge: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800',
        card: 'bg-indigo-50/50 dark:bg-indigo-950/20 border-indigo-200/80 dark:border-indigo-900/50'
      };
    case 'Behavior':
      return {
        badge: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800',
        card: 'bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200/80 dark:border-emerald-900/50'
      };
    case 'Participation':
      return {
        badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800',
        card: 'bg-amber-50/50 dark:bg-amber-950/20 border-amber-200/80 dark:border-amber-900/50'
      };
    case 'Performance':
      return {
        badge: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800',
        card: 'bg-rose-50/50 dark:bg-rose-950/20 border-rose-200/80 dark:border-rose-900/50'
      };
    case 'Remarks':
      return {
        badge: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-800',
        card: 'bg-purple-50/50 dark:bg-purple-950/20 border-purple-200/80 dark:border-purple-900/50'
      };
    default:
      return {
        badge: 'bg-slate-100 text-slate-600 border border-slate-200',
        card: 'bg-white border-slate-200'
      };
  }
};

export default function GradingTab({ userId, ratingPriorities: propRatingPriorities }: GradingTabProps) {
  // Target Document ID priority: Dynamic userId prop -> Current logged in email -> default fallbacks
  const userDocId = userId || auth?.currentUser?.email || "admin@gmail.com";

  const [localRatingPriorities] = useState<RatingPriority[]>(DEFAULT_RATING_PRIORITIES);
  const ratingPriorities = propRatingPriorities ?? localRatingPriorities;
  const [remarksMap, setRemarksMap] = useState<Record<RatingLevel, RemarkPreset[]>>({
    Excellent: [],
    Good: [],
    Average: [],
    Poor: [],
  });

  const [activeModalLevel, setActiveModalLevel] = useState<RatingPriority['level'] | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [autoFillLoading, setAutoFillLoading] = useState<boolean>(true);
  const [autoFillPresets, setAutoFillPresets] = useState<AdminAutoFillPresets | null>(null);
  const [autoFillError, setAutoFillError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [showNotification, setShowNotification] = useState<boolean>(false);
  const [notificationMsg, setNotificationMsg] = useState<string>('');

  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const [newCategory, setNewCategory] = useState<RemarkPreset['category']>('Homework');
  const [newRemarkText, setNewRemarkText] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const remarkTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRangeRef = useRef<{ start: number; end: number } | null>(null);

  // Custom Category Selector Modal state
  const [isCategoryPickerOpen, setIsCategoryPickerOpen] = useState<boolean>(false);

  const availableCategories = useMemo(() => {
    if (!activeModalLevel) return ALL_CATEGORIES;
    const currentPresets = remarksMap[activeModalLevel] || [];
    
    return ALL_CATEGORIES.filter(cat => {
      if (editingId) {
        const editingPreset = currentPresets.find(p => p.id === editingId);
        if (editingPreset && editingPreset.category === cat) return true;
      }
      return !currentPresets.some(p => p.category === cat);
    });
  }, [activeModalLevel, remarksMap, editingId]);

  useEffect(() => {
    if (availableCategories.length > 0 && !availableCategories.includes(newCategory)) {
      setNewCategory(availableCategories[0]);
    }
  }, [availableCategories, newCategory]);

  useEffect(() => {
    let active = true;

    const fetchGradingRules = async () => {
      if (!userDocId) return;
      setLoading(true);
      try {
        const docRef = doc(db, 'users', userDocId, 'settings', 'grading_rules');
        const docSnap = await getDoc(docRef);

        if (active && docSnap.exists()) {
          const data = docSnap.data();
          if (data.remarksMap) setRemarksMap(normalizeRemarksMap(data.remarksMap) as Record<RatingLevel, RemarkPreset[]>);
        }
      } catch (error) {
        console.error('Error fetching grading rules:', error);
      } finally {
        if (active) setLoading(false);
      }
    };

    const loadCentralAutoFillPresets = async () => {
      setAutoFillLoading(true);
      setAutoFillError(null);
      try {
        const central = await fetchCentralAutoFillPresets();
        if (active) {
          setAutoFillPresets(central.presets);
        }
      } catch (error) {
        if (active) {
          setAutoFillPresets(null);
          setAutoFillError(error instanceof Error ? error.message : 'Central grading presets could not be loaded.');
        }
      } finally {
        if (active) setAutoFillLoading(false);
      }
    };

    void fetchGradingRules();
    void loadCentralAutoFillPresets();
    return () => { active = false; };
  }, [userDocId]);

  const handleSaveRemarkPreset = () => {
    if (!activeModalLevel || !newRemarkText.trim() || (availableCategories.length === 0 && !editingId)) return;

    const currentList = remarksMap[activeModalLevel] || [];

    if (editingId) {
      const updatedList = currentList.map(item => 
        item.id === editingId 
          ? { ...item, category: newCategory, remarkText: newRemarkText.trim(), source: 'teacher' } 
          : item
      );
      setRemarksMap({ ...remarksMap, [activeModalLevel]: updatedList });
    } else {
      const newPreset: RemarkPreset = {
        id: Date.now().toString(),
        category: newCategory,
        remarkText: newRemarkText.trim(),
        source: 'teacher',
      };
      setRemarksMap({ ...remarksMap, [activeModalLevel]: [...currentList, newPreset] });
    }

    setNewRemarkText('');
    selectionRangeRef.current = null;
    setEditingId(null);
  };

  const confirmDeleteRemark = () => {
    if (!activeModalLevel || !deleteTargetId) return;
    const updatedList = (remarksMap[activeModalLevel] || []).filter(item => item.id !== deleteTargetId);
    setRemarksMap({ ...remarksMap, [activeModalLevel]: updatedList });
    setDeleteTargetId(null);
    
    setNotificationMsg("Preset remark deleted successfully!");
    setShowNotification(true);
  };

  const handleStartEdit = (preset: RemarkPreset) => {
    setEditingId(preset.id);
    setNewCategory(preset.category);
    setNewRemarkText(preset.remarkText);
    selectionRangeRef.current = { start: preset.remarkText.length, end: preset.remarkText.length };
  };

  const captureRemarkSelection = (element: HTMLTextAreaElement) => {
    selectionRangeRef.current = { start: element.selectionStart, end: element.selectionEnd };
  };

  const insertPersonalizedVariable = (variable: PersonalizedRemarkVariable) => {
    const textarea = remarkTextareaRef.current;
    const savedSelection = selectionRangeRef.current;
    // Prefer the live DOM selection only while the textarea owns focus. If another control
    // was clicked (e.g. Edit Preset), use the last saved selection or safely append at the end.
    const textareaOwnsSelection = Boolean(textarea && document.activeElement === textarea);
    const start = textareaOwnsSelection && textarea
      ? textarea.selectionStart
      : (savedSelection?.start ?? newRemarkText.length);
    const end = textareaOwnsSelection && textarea
      ? textarea.selectionEnd
      : (savedSelection?.end ?? start);
    const insertion = insertTextAtSelection(newRemarkText, `{{${variable}}}`, start, end);

    setNewRemarkText(insertion.value);
    selectionRangeRef.current = { start: insertion.cursorPosition, end: insertion.cursorPosition };

    // Restore focus and place the caret directly after the inserted token after React renders.
    window.requestAnimationFrame(() => {
      const currentTextarea = remarkTextareaRef.current;
      if (!currentTextarea) return;
      currentTextarea.focus();
      currentTextarea.setSelectionRange(insertion.cursorPosition, insertion.cursorPosition);
      captureRemarkSelection(currentTextarea);
    });
  };

  // Load the latest central templates, add missing categories, and refresh only
  // presets still marked as Admin-managed. Teacher-edited presets remain untouched.
  const handleAutoFillLevel = async (level: RatingLevel) => {
    setAutoFillLoading(true);
    setAutoFillError(null);
    try {
      // Fetch again on every click so an Admin's latest wording is used even if this
      // Settings page has stayed open since the central templates were changed.
      const central = await fetchCentralAutoFillPresets();
      const latestPresets = central.presets;
      const legacyDefaults = central.legacyDefaults;
      setAutoFillPresets(latestPresets);

      const currentPresets = remarksMap[level] || [];
      const existingCategories = new Set(currentPresets.map((preset) => preset.category));
      const missingPresets = ALL_CATEGORIES
        .filter((category) => !existingCategories.has(category))
        .map((category, index) => ({
          id: `${level.toLowerCase()}-autofill-${Date.now()}-${index}`,
          category,
          remarkText: latestPresets[level][category],
          source: 'admin' as const,
        }));

      let refreshedManagedCount = 0;
      const refreshedPresets = currentPresets.map((preset) => {
        // Older presets without a source marker are treated as teacher-owned to
        // protect existing customization during this migration.
        const matchesLegacyBuiltIn = !preset.source
          && preset.remarkText.trim() === legacyDefaults[level][preset.category].trim();
        const isAdminManaged = preset.source === 'admin' || matchesLegacyBuiltIn;
        if (!isAdminManaged) return preset;
        const remarkText = latestPresets[level][preset.category];
        if (preset.remarkText !== remarkText || preset.source !== 'admin') refreshedManagedCount += 1;
        return { ...preset, remarkText, source: 'admin' as const };
      });

      const hasChanges = missingPresets.length > 0 || refreshedManagedCount > 0;
      if (!hasChanges) {
        setNotificationMsg(`${level} already has all five categories. Your teacher-customized remarks were kept; no changes were needed.`);
        setShowNotification(true);
        return;
      }

      setRemarksMap((previous) => ({
        ...previous,
        [level]: [...refreshedPresets, ...missingPresets],
      }));
      const updates = [
        missingPresets.length ? `${missingPresets.length} missing category preset(s) added` : '',
        refreshedManagedCount ? `${refreshedManagedCount} Admin-managed preset(s) refreshed` : '',
      ].filter(Boolean).join(' and ');
      setNotificationMsg(`${level}: ${updates}. Teacher-customized remarks were preserved. Click Save Grading Rules to save your changes.`);
      setShowNotification(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Central grading presets could not be loaded.';
      setAutoFillError(message);
      setNotificationMsg(message);
      setShowNotification(true);
    } finally {
      setAutoFillLoading(false);
    }
  };

  const handleSaveAllToFirestore = async () => {
    setSaving(true);
    try {
      const docRef = doc(db, 'users', userDocId, 'settings', 'grading_rules');
      
      await setDoc(docRef, {
        remarksMap: serializeRemarksMap(remarksMap),
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      setNotificationMsg("Data saved successfully!");
      setShowNotification(true);
    } catch (error) {
      console.error('Error saving rules:', error);
      alert('Failed to save rules!');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 w-full max-w-6xl mx-auto p-1 sm:p-2 pb-24">
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-3">
          <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
          <p className="text-xs text-slate-400 font-bold">Loading Grading Rules...</p>
        </div>
      ) : (
        <>
          {/* MAIN CARD CONTAINER */}
          <div className="glass-card rounded-2xl border border-border/50 bg-card/90 p-4 shadow-sm sm:p-6 space-y-5">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
              <div>
                <h3 className="text-sm sm:text-base font-black flex items-center gap-2 text-slate-800 dark:text-slate-100">
                  <Award className="h-5 w-5 sm:h-6 sm:w-6 text-orange-500 shrink-0" /> Performance Rating Rules
                </h3>
                <p className="text-[11px] sm:text-xs text-slate-500 font-medium mt-1">
                  Click any level below to configure automated remarks for monthly reports.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl border border-blue-500/20 bg-blue-500/5 p-3 text-[11px] leading-5 text-muted-foreground">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
              <p>Auto Fill uses the latest English templates managed centrally in the Admin Panel. Existing teacher-customized remarks are preserved; untouched built-in Auto Fill remarks are safely migrated to the central templates. Save Grading Rules after filling to keep your changes.</p>
            </div>
            {autoFillError ? (
              <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/20 bg-rose-500/5 p-3 text-[11px] leading-5 text-rose-600 dark:text-rose-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>Central Auto Fill presets could not be loaded: {autoFillError}. Reopen Settings or refresh the page and try again.</p>
              </div>
            ) : null}

            {/* CLICKABLE CARDS LIST */}
            <div className="space-y-3">
              {ratingPriorities.map((item) => {
                const remarksCount = remarksMap[item.level]?.length || 0;
                return (
                  <div
                    key={item.level}
                    className={`p-3 sm:p-4 rounded-2xl border ${item.bgColor} ${item.borderColor} transition-all duration-200 hover:scale-[1.01] flex items-center justify-between gap-2 sm:gap-4 cursor-pointer`}
                    onClick={() => {
                      setActiveModalLevel(item.level);
                      setEditingId(null);
                      setNewRemarkText('');
                      selectionRangeRef.current = null;
                    }}
                  >
                    <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0">
                      <div className={`text-[11px] sm:text-xs font-black px-2.5 sm:px-3.5 py-1 sm:py-1.5 rounded-xl bg-white dark:bg-slate-900 shadow-sm ${item.color} shrink-0`}>
                        {item.level}
                      </div>
                      <span className="text-[11px] sm:text-xs font-bold text-slate-500 dark:text-slate-400 truncate">
                        {item.badgeText}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleAutoFillLevel(item.level);
                        }}
                        disabled={autoFillLoading || !autoFillPresets}
                        aria-label={`Auto-fill ${item.level} remarks for all categories`}
                        title={autoFillError || `Fill missing ${item.level} remarks using the latest Admin-managed templates`}
                        className="inline-flex items-center justify-center gap-1 rounded-xl border border-orange-300/80 dark:border-orange-800/80 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white px-2 py-1.5 sm:px-3 sm:py-2 text-[9px] sm:text-[10px] font-black shadow-md shadow-orange-500/20 transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0c1222] whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {autoFillLoading ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 shrink-0" />}
                        <span>{autoFillLoading ? 'Loading' : 'Auto Fill'}</span>
                      </button>
                      <span className="text-[10px] font-extrabold bg-white/90 dark:bg-slate-900/90 text-slate-600 dark:text-slate-300 px-2 sm:px-2.5 py-1 rounded-lg flex items-center gap-1 shadow-sm shrink-0">
                        <MessageSquareText className="w-3 h-3 text-orange-500 shrink-0" />
                        <span>{remarksCount} Presets</span>
                      </span>
                      <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* SAVE BUTTON */}
            <div className="pt-2">
              <button
                onClick={handleSaveAllToFirestore}
                disabled={saving}
                className="w-full bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-black py-3.5 sm:py-4 px-6 rounded-2xl shadow-lg shadow-orange-500/25 active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 text-xs sm:text-sm uppercase tracking-wider"
              >
                {saving ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Save className="w-5 h-5" />
                )}
                <span>Save Grading Rules</span>
              </button>
            </div>

          </div>
        </>
      )}

      {/* EDIT / ADD REMARKS MODAL */}
      {activeModalLevel && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="relative w-full max-w-md my-auto rounded-[32px] p-[2.5px] bg-gradient-to-r from-orange-500 via-amber-500 to-orange-500 shadow-[0_0_30px_rgba(249,115,22,0.35)]">
            <div className="bg-white dark:bg-[#0c1222] w-full rounded-[30px] p-4 sm:p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-200 max-h-[85vh] flex flex-col">
              
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3 shrink-0">
                <span className="text-xs font-black px-3.5 py-1.5 rounded-xl bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20 shadow-sm">
                  {activeModalLevel} Level Remarks
                </span>
                <button
                  onClick={() => setActiveModalLevel(null)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4 overflow-y-auto pr-1 flex-1 pb-2">
                <div className="bg-slate-50/80 dark:bg-[#070b13] p-3.5 sm:p-4 rounded-2xl border border-slate-200/80 dark:border-slate-800 space-y-3">
                  <span className="text-[11px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    {editingId ? 'Edit Preset Remark' : 'Add New Preset Remark'}
                  </span>

                  <div className="flex gap-2 items-center">
                    <button
                      type="button"
                      disabled={availableCategories.length === 0 && !editingId}
                      onClick={() => setIsCategoryPickerOpen(true)}
                      className="flex-1 flex items-center justify-between bg-white dark:bg-[#111827] text-slate-800 dark:text-slate-100 border-2 border-orange-500/40 hover:border-orange-500 rounded-xl px-3 sm:px-3.5 py-2.5 text-xs font-black outline-none shadow-sm transition-all disabled:opacity-50 min-w-0"
                    >
                      <span className="truncate">
                        {availableCategories.length === 0 && !editingId ? "All Added" : newCategory}
                      </span>
                      <ChevronDown className="w-4 h-4 text-orange-500 shrink-0 ml-1" />
                    </button>

                    <button
                      onClick={handleSaveRemarkPreset}
                      disabled={availableCategories.length === 0 && !editingId}
                      className="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-black text-xs px-3.5 sm:px-4 py-2.5 rounded-xl flex items-center gap-1.5 shrink-0 shadow-md shadow-orange-500/20 active:scale-95 transition-all disabled:opacity-50"
                    >
                      {editingId ? <Save className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                      <span>{editingId ? 'Update' : 'Add'}</span>
                    </button>
                  </div>

                  <textarea
                    ref={remarkTextareaRef}
                    value={newRemarkText}
                    disabled={availableCategories.length === 0 && !editingId}
                    onChange={(e) => {
                      setNewRemarkText(e.target.value);
                      captureRemarkSelection(e.currentTarget);
                    }}
                    onSelect={(e) => captureRemarkSelection(e.currentTarget)}
                    onKeyUp={(e) => captureRemarkSelection(e.currentTarget)}
                    onClick={(e) => captureRemarkSelection(e.currentTarget)}
                    placeholder={availableCategories.length === 0 && !editingId ? "All categories have preset remarks added." : "Write preset auto-response remark here..."}
                    rows={3}
                    aria-label="Preset remark template"
                    className="w-full bg-white dark:bg-[#111827] text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-800 rounded-xl p-3 text-xs outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/15 font-medium shadow-inner disabled:opacity-50 resize-y min-h-[76px]"
                  />

                  {/* PERSONALIZED VARIABLES — tokens stay in Firestore templates and resolve per report. */}
                  <div className="rounded-2xl border border-orange-200/80 dark:border-orange-900/60 bg-gradient-to-br from-orange-50/80 via-white to-amber-50/60 dark:from-orange-950/25 dark:via-[#0c1222] dark:to-amber-950/15 p-3 sm:p-3.5 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-7 w-7 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-sm flex items-center justify-center shrink-0">
                        <Sparkles className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-[10px] sm:text-[11px] font-black tracking-[0.12em] text-orange-700 dark:text-orange-300 uppercase">
                          Insert Personalized Variables
                        </h4>
                        <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                          Click a chip to insert at your current cursor position.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2" aria-label="Personalized variable insertion">
                      {([
                        { key: 'name', label: 'Full student name', token: '{{name}}', tooltip: 'Inserts the selected student’s full name from the class student record.' },
                        { key: 'father_name', label: 'Father’s name', token: '{{father_name}}', tooltip: 'Inserts the father’s name from the same student record.' },
                        { key: 'first_name', label: 'First name', token: '{{first_name}}', tooltip: 'Uses the student’s firstName field when available, otherwise the first word of their full name.' },
                      ] as const).map((variable) => (
                        <button
                          key={variable.key}
                          type="button"
                          title={variable.tooltip}
                          aria-label={`Insert ${variable.token}: ${variable.tooltip}`}
                          disabled={availableCategories.length === 0 && !editingId}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => insertPersonalizedVariable(variable.key)}
                          className="group inline-flex items-center gap-1.5 rounded-xl border border-orange-300/80 dark:border-orange-800/80 bg-white/90 dark:bg-slate-900/90 px-2.5 py-2 text-[10px] sm:text-[11px] font-black text-orange-700 dark:text-orange-300 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-orange-500 hover:bg-orange-100/90 dark:hover:bg-orange-950/40 hover:shadow-md hover:shadow-orange-500/10 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0c1222] disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Sparkles className="h-3 w-3 text-amber-500 transition-transform group-hover:rotate-12" />
                          <span>{variable.token}</span>
                          <span className="font-semibold text-slate-500 dark:text-slate-400">{variable.label}</span>
                        </button>
                      ))}
                    </div>

                    <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white/75 dark:bg-[#070b13]/75 p-3 space-y-1.5">
                      <div className="flex items-center gap-1.5 text-[10px] font-black text-slate-600 dark:text-slate-300">
                        <UserRound className="h-3.5 w-3.5 text-orange-500" />
                        Template preview <span className="ml-auto rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[8px] uppercase tracking-wide text-slate-500 dark:text-slate-400">No student selected</span>
                      </div>
                      <p className="min-h-[20px] whitespace-pre-wrap break-words text-[11px] leading-relaxed font-semibold text-slate-700 dark:text-slate-200">
                        {newRemarkText || 'Your reusable remark template will appear here as you type.'}
                      </p>
                      <p className="text-[9px] leading-relaxed text-slate-500 dark:text-slate-400">
                        {newRemarkText.includes('{{')
                          ? 'Tokens remain unchanged in the saved preset. Reports resolve them separately using each selected student’s own record.'
                          : 'Add a variable chip to personalize this reusable remark for each student when a report is generated.'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <span className="text-xs font-black text-slate-400">
                    Saved Presets ({remarksMap[activeModalLevel]?.length || 0})
                  </span>
                  
                  {(!remarksMap[activeModalLevel] || remarksMap[activeModalLevel].length === 0) && (
                    <p className="text-xs text-slate-400 text-center py-6 italic font-medium">
                      No preset remarks saved yet.
                    </p>
                  )}

                  {remarksMap[activeModalLevel]?.map((preset) => {
                    const style = getCategoryStyles(preset.category);
                    return (
                      <div
                        key={preset.id}
                        className={`p-3 sm:p-3.5 rounded-2xl border transition-all duration-200 flex items-center justify-between gap-3 text-xs ${style.card}`}
                      >
                        <div className="space-y-1.5 flex-1 pr-1 min-w-0">
                          <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-lg inline-block ${style.badge}`}>
                            {preset.category}
                          </span>
                          <p className="text-slate-800 dark:text-slate-200 font-bold pl-0.5 leading-relaxed break-words">
                            {preset.remarkText}
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => handleStartEdit(preset)}
                            title="Edit Preset"
                            className="p-1.5 sm:p-2 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 rounded-xl border border-emerald-200/60 dark:border-emerald-800/60 transition-colors shadow-sm"
                          >
                            <Edit3 className="w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[2.2]" />
                          </button>

                          <button
                            onClick={() => setDeleteTargetId(preset.id)}
                            title="Delete Preset"
                            className="p-1.5 sm:p-2 text-rose-600 dark:text-rose-400 hover:text-rose-700 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 rounded-xl border border-rose-200/60 dark:border-rose-800/60 transition-colors shadow-sm"
                          >
                            <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[2.2]" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="pt-2 shrink-0">
                <button
                  onClick={() => setActiveModalLevel(null)}
                  className="w-full bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold py-3 rounded-2xl text-xs transition-all active:scale-[0.99]"
                >
                  Done & Close
                </button>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* CATEGORY PICKER MODAL */}
      {isCategoryPickerOpen && (
        <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
          <div className="relative w-full max-w-sm rounded-[32px] p-[2px] bg-gradient-to-r from-orange-500 via-amber-500 to-orange-500 shadow-[0_0_35px_rgba(249,115,22,0.4)] animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-white dark:bg-[#0c1222] rounded-[30px] p-5 space-y-4">
              
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center font-black shrink-0">
                    <Award className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-black text-slate-800 dark:text-slate-100">
                      Select Category
                    </h4>
                    <p className="text-[11px] text-slate-400 font-medium">
                      Choose category for remark
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setIsCategoryPickerOpen(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-2.5 max-h-60 overflow-y-auto py-1 pr-1">
                {availableCategories.map((cat) => {
                  const isSelected = newCategory === cat;
                  return (
                    <div
                      key={cat}
                      onClick={() => {
                        setNewCategory(cat);
                      }}
                      className={`p-3.5 rounded-2xl border-2 transition-all cursor-pointer flex items-center justify-between ${
                        isSelected
                          ? 'border-orange-500 bg-orange-500/5 dark:bg-orange-500/10 shadow-[0_0_15px_rgba(249,115,22,0.15)]'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-white dark:bg-[#111827]'
                      }`}
                    >
                      <span className={`text-xs font-black ${isSelected ? 'text-orange-600 dark:text-orange-400' : 'text-slate-700 dark:text-slate-200'}`}>
                        {cat}
                      </span>

                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                        isSelected 
                          ? 'border-orange-500 bg-orange-500 text-white' 
                          : 'border-slate-300 dark:border-slate-600'
                      }`}>
                        {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                onClick={() => setIsCategoryPickerOpen(false)}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3 rounded-2xl text-xs flex items-center justify-center gap-1.5 shadow-md shadow-orange-500/25 active:scale-95 transition-all"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Confirm Selection</span>
              </button>

            </div>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {deleteTargetId && (
        <div className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
          <div className="relative w-full max-w-xs rounded-[28px] p-[2px] bg-gradient-to-r from-rose-500 via-red-500 to-rose-500 shadow-[0_0_25px_rgba(244,63,94,0.35)]">
            <div className="bg-white dark:bg-[#0c1222] rounded-[26px] p-5 text-center space-y-4 animate-in fade-in zoom-in-95 duration-200">
              <div className="w-12 h-12 bg-rose-500/10 text-rose-500 rounded-2xl border border-rose-500/20 flex items-center justify-center mx-auto shadow-inner">
                <AlertTriangle className="w-6 h-6 stroke-[2.2]" />
              </div>

              <div className="space-y-1">
                <h4 className="text-sm font-black text-slate-800 dark:text-slate-100">
                  Delete Preset Remark?
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium leading-relaxed">
                  Are you sure you want to remove this preset? This action cannot be undone.
                </p>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setDeleteTargetId(null)}
                  className="w-1/2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold py-2.5 rounded-xl text-xs transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeleteRemark}
                  className="w-1/2 bg-rose-500 hover:bg-rose-600 text-white font-black py-2.5 rounded-xl text-xs shadow-md shadow-rose-500/20 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUCCESS POPUP NOTIFICATION */}
      {showNotification && (
        <div className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="relative w-full max-w-xs rounded-[28px] p-[2px] bg-gradient-to-r from-orange-500 via-amber-500 to-orange-500 shadow-[0_0_25px_rgba(249,115,22,0.4)]">
            <div className="bg-white dark:bg-[#0c1222] rounded-[26px] p-6 text-center space-y-4 animate-in fade-in zoom-in-95 duration-200">
              <div className="w-14 h-14 bg-emerald-500/10 text-emerald-500 rounded-2xl border border-emerald-500/20 flex items-center justify-center mx-auto shadow-inner">
                <CheckCircle2 className="w-8 h-8 stroke-[2.5]" />
              </div>

              <div className="space-y-1">
                <h4 className="text-base font-black text-slate-800 dark:text-slate-100">
                  Success!
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                  {notificationMsg}
                </p>
              </div>

              <button
                onClick={() => setShowNotification(false)}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3 rounded-xl text-xs transition-colors shadow-md shadow-orange-500/20"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
