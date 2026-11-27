import React, { useState, useEffect } from 'react';
import { FileText, Save, CheckCircle2, Loader2, Check } from 'lucide-react';
import { db, auth } from "../../lib/firebase"; 
import { doc, getDoc, setDoc } from 'firebase/firestore';

export interface ReportMetrics {
  homeworkEnabled: boolean;
  behaviorEnabled: boolean;
  participationEnabled: boolean;
  performanceEnabled: boolean;
  teacherRemarksRequired: boolean;
}

interface ReportConfigTabProps {
  userId?: string;
  reportMetrics?: ReportMetrics;
  setReportMetrics?: React.Dispatch<React.SetStateAction<ReportMetrics>>;
}

const DEFAULT_METRICS: ReportMetrics = {
  homeworkEnabled: true,
  behaviorEnabled: true,
  participationEnabled: true,
  performanceEnabled: true,
  teacherRemarksRequired: true,
};

export default function ReportConfigTab({ userId }: ReportConfigTabProps) {
  // Dynamic User Document ID fallback strategy
  const userDocId = userId || auth?.currentUser?.email || "admin@gmail.com";

  // Local States
  const [metrics, setMetrics] = useState<ReportMetrics>(DEFAULT_METRICS);
  const [savedMetrics, setSavedMetrics] = useState<ReportMetrics>(DEFAULT_METRICS);
  const [hasSavedConfig, setHasSavedConfig] = useState<boolean>(false);
  const [settingsLoaded, setSettingsLoaded] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [showNotification, setShowNotification] = useState<boolean>(false);
  const hasChanges = !hasSavedConfig || JSON.stringify(metrics) !== JSON.stringify(savedMetrics);

  // Configuration Fields List
  const options: { key: keyof ReportMetrics; label: string; desc: string }[] = [
    { 
      key: 'homeworkEnabled', 
      label: 'Homework Evaluation Field', 
      desc: 'Show homework performance & completion field' 
    },
    { 
      key: 'behaviorEnabled', 
      label: 'Student Behavior Rating Field', 
      desc: 'Include behavioral observation metric' 
    },
    { 
      key: 'participationEnabled', 
      label: 'Class Participation Field', 
      desc: 'Track student active engagement in class' 
    },
    { 
      key: 'performanceEnabled', 
      label: 'General Performance Field', 
      desc: 'Include overall academic performance score' 
    },
    { 
      key: 'teacherRemarksRequired', 
      label: 'Teacher Remarks Text Area', 
      desc: 'Enable custom feedback comment box' 
    },
  ];

  // Fetch Existing Settings from Firestore (`users/{userDocId}/settings/report_config`)
  useEffect(() => {
    const fetchReportConfig = async () => {
      if (!userDocId) return;
      setSettingsLoaded(false);
      setLoading(true);
      let didLoadSuccessfully = false;
      try {
        const docRef = doc(db, 'users', userDocId, 'settings', 'report_config');
        const docSnap = await getDoc(docRef);

        let loadedMetrics = DEFAULT_METRICS;
        if (docSnap.exists()) {
          const data = docSnap.data();
          const stored = data.reportMetrics && typeof data.reportMetrics === 'object'
            ? data.reportMetrics as Partial<ReportMetrics>
            : {};
          loadedMetrics = {
            homeworkEnabled: typeof stored.homeworkEnabled === 'boolean' ? stored.homeworkEnabled : DEFAULT_METRICS.homeworkEnabled,
            behaviorEnabled: typeof stored.behaviorEnabled === 'boolean' ? stored.behaviorEnabled : DEFAULT_METRICS.behaviorEnabled,
            participationEnabled: typeof stored.participationEnabled === 'boolean' ? stored.participationEnabled : DEFAULT_METRICS.participationEnabled,
            performanceEnabled: typeof stored.performanceEnabled === 'boolean' ? stored.performanceEnabled : DEFAULT_METRICS.performanceEnabled,
            teacherRemarksRequired: typeof stored.teacherRemarksRequired === 'boolean' ? stored.teacherRemarksRequired : DEFAULT_METRICS.teacherRemarksRequired,
          };
        }
        setMetrics(loadedMetrics);
        setSavedMetrics(loadedMetrics);
        setHasSavedConfig(docSnap.exists());
        didLoadSuccessfully = true;
      } catch (error) {
        console.error('Error fetching report config:', error);
        setMetrics(DEFAULT_METRICS);
        setSavedMetrics(DEFAULT_METRICS);
        setHasSavedConfig(false);
      } finally {
        setSettingsLoaded(didLoadSuccessfully);
        setLoading(false);
      }
    };

    fetchReportConfig();
  }, [userDocId]);

  // Toggle Function
  const handleToggle = (key: keyof ReportMetrics) => {
    setShowNotification(false);
    setMetrics((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // Save Config to Firestore Sub-collection
  const handleSaveToFirestore = async () => {
    if (!hasChanges || !settingsLoaded || saving) return;
    setSaving(true);
    try {
      const docRef = doc(db, 'users', userDocId, 'settings', 'report_config');
      await setDoc(
        docRef,
        {
          reportMetrics: metrics,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

      setSavedMetrics({ ...metrics });
      setHasSavedConfig(true);
      setShowNotification(true);
    } catch (error) {
      console.error('Error saving report config:', error);
      alert('Failed to save configurations!');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 w-full max-w-6xl mx-auto p-1 sm:p-2 pb-24">
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-3">
          <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
          <p className="text-xs text-slate-400 font-bold">Loading Configuration...</p>
        </div>
      ) : (
      <div className="glass-card overflow-hidden rounded-2xl border border-border/50 bg-card/90 p-4 shadow-sm sm:p-6 space-y-5">
          {/* Card Header */}
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
            <div>
              <h3 className="text-base font-black flex items-center gap-2 text-slate-800 dark:text-slate-100">
                <FileText className="h-5 w-5 text-orange-500" /> Monthly Report Form Fields
              </h3>
              <p className="text-xs text-slate-600 font-medium mt-1">
                Enable or disable fields shown in the teacher monthly evaluation modal.
              </p>
            </div>
          </div>

          {/* Options List */}
          <div className="space-y-3">
            {options.map((item) => {
              const isChecked = metrics[item.key];
              return (
                <div
                  key={item.key}
                  onClick={() => handleToggle(item.key)}
                  className={`p-4 rounded-2xl border transition-all duration-200 cursor-pointer flex items-center justify-between gap-4 ${
                    isChecked
                      ? 'bg-orange-50/40 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800/50 shadow-sm'
                      : 'bg-slate-50/60 dark:bg-[#070b13] border-slate-200/70 dark:border-slate-800 opacity-75'
                  }`}
                >
                  {/* Left Label & Description */}
                  <div className="space-y-0.5">
                    <h4 className="text-xs font-black text-slate-800 dark:text-slate-200">
                      {item.label}
                    </h4>
                    <p className="text-[11px] text-slate-400 font-medium">
                      {item.desc}
                    </p>
                  </div>

                  {/* Custom Styled Checkbox Container */}
                  <div className="shrink-0 flex items-center">
                    <div
                      className={`w-6 h-6 rounded-lg flex items-center justify-center transition-all duration-200 border ${
                        isChecked
                          ? 'bg-orange-500 border-orange-500 shadow-md shadow-orange-500/30'
                          : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700'
                      }`}
                    >
                      {isChecked && <Check className="w-4 h-4 text-white stroke-[3]" />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* MOBILE RESPONSIVE SAVE BUTTON */}
          <div className="pt-2">
            <button
              onClick={handleSaveToFirestore}
              disabled={saving || !settingsLoaded || !hasChanges}
              className="w-full bg-gradient-to-r from-primary to-accent hover:opacity-90 text-primary-foreground font-black py-3 sm:py-3.5 px-4 sm:px-6 rounded-xl shadow-md active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 text-xs sm:text-sm uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" />
              ) : hasChanges ? (
                <Save className="w-4 h-4 sm:w-5 sm:h-5" />
              ) : (
                <CheckCircle2 className="w-4 h-4 sm:w-5 sm:h-5" />
              )}
              <span className="truncate">{saving ? 'Saving Configuration…' : hasChanges ? 'Save Report Configuration' : 'No pending changes'}</span>
            </button>
          </div>

        </div>
      )}

      {/* ================= SUCCESS POPUP NOTIFICATION ================= */}
      {showNotification && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#0c1222] border border-slate-100 dark:border-slate-800 rounded-3xl p-6 shadow-2xl max-w-xs w-full text-center space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-950/50 text-emerald-500 rounded-full flex items-center justify-center mx-auto shadow-inner">
              <CheckCircle2 className="w-10 h-10 stroke-[2.5]" />
            </div>

            <div className="space-y-1">
              <h4 className="text-lg font-black text-slate-800 dark:text-slate-100">
                Configurations Saved 
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                Report form field settings have been successfully updated 
              </p>
            </div>

            <button
              onClick={() => setShowNotification(false)}
              className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3 rounded-2xl text-xs transition-colors shadow-md shadow-orange-500/20"
            >
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
