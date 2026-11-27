import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useOutletContext } from "react-router-dom";
import type { User } from "firebase/auth";
import { AppProvider } from "@/contexts/AppContext";
import { Layout } from "@/components/Layout";
import { FeatureRoute } from "@/components/FeatureRoute";

// Auth & Public Pages
import LoadingPage from "./pages/LoadingPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import SharedDocumentPage from "@/components/SharedDocumentPage";

// Main Dashboard Pages
import Dashboard from "./pages/Dashboard";
import ClassesPage from "./pages/ClassesPage";
import DepartmentsPage from "./pages/DepartmentsPage";
import Attendance from "./pages/attendance";
import Fees from "./pages/fees";
import Reports from "./pages/reports";
import Analytics from "./pages/analytics";
import Notes from "./pages/notes";
import Alerts from "./pages/alerts";
import Quiz from "./pages/quiz";
import Settings from "./pages/settings";
import ExtraFee from "./components/fees/extrafee";

// Admin Portal Pages
import AdminLogin from "./pages/admin/AdminLogin";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminAnalytics from "./pages/admin/Analytics";
import Customers from "./pages/admin/Customers";
import WhatsAppManagement from "./pages/admin/WhatsAppManagement";
import AdminSubscriptions from "./pages/admin/Subscriptions";
import AdminGradingPresets from "./pages/admin/GradingPresets";
import AdminTeacherAnnouncements from "./pages/admin/TeacherAnnouncements";
import AdminRouteGuard from "@/components/AdminRouteGuard";
import AcademyAdminRouteGuard from "@/components/AcademyAdminRouteGuard";
import AcademyAdminLayout from "./pages/academy-admin/AcademyAdminLayout";
import AcademyAdminOverview from "./pages/academy-admin/AcademyAdminOverview";
import AcademyClassesPage from "./pages/academy-admin/AcademyClassesPage";
import AcademyStudentsPage from "./pages/academy-admin/AcademyStudentsPage";
import AcademyFeesPage from "./pages/academy-admin/AcademyFeesPage";
import AcademyExpensesPage from "./pages/academy-admin/AcademyExpensesPage";
import AcademyTeachersPage from "./pages/academy-admin/AcademyTeachersPage";
import AcademyTeacherProfilePage from "./pages/academy-admin/AcademyTeacherProfilePage";
import AcademyAnalyticsPage from "./pages/academy-admin/AcademyAnalyticsPage";
import AcademyAlertsPage from "./pages/academy-admin/AcademyAlertsPage";
import { AcademyPermissionRoute } from "@/components/AcademyPermissionRoute";

type AdminOutletContext = {
  adminUser: User | null;
  localDark: boolean;
};

function AdminSubscriptionsRoute() {
  const { adminUser, localDark } = useOutletContext<AdminOutletContext>();

  if (!adminUser) {
    return <Navigate to="/admin/login" replace />;
  }

  return <AdminSubscriptions adminUser={adminUser} localDark={localDark} />;
}

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AppProvider>
        <Toaster />
        <Sonner />

        <BrowserRouter>
          <Routes>
            {/* 1. INITIAL LOADING SCREEN */}
            <Route path="/" element={<LoadingPage />} />

            {/* 2. AUTHENTICATION PAGES */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />

            {/* 3. PUBLIC SHARE ROUTE */}
            <Route path="/notes/share" element={<SharedDocumentPage />} />

            {/* 4. ADMIN PORTAL ROUTES */}
            <Route path="/admin/login" element={<AdminLogin />} />

            {/* The AdminDashboard is the shared protected layout/navbar. Each child route
                mounts the page component from its own file under src/pages/admin/. */}
            <Route element={<AdminRouteGuard />}>
              <Route path="/admin" element={<AdminDashboard />}>
                <Route index element={<Navigate to="/admin/dashboard" replace />} />
                {/* Dashboard markup is hosted by AdminDashboard.tsx itself. */}
                <Route path="dashboard" element={<></>} />
                <Route path="billing" element={<Navigate to="/admin/dashboard" replace />} />
                <Route path="subscriptions" element={<AdminSubscriptionsRoute />} />
                <Route path="customers" element={<Customers />} />
                <Route path="analytics" element={<AdminAnalytics />} />
                <Route path="whatsapp" element={<WhatsAppManagement />} />
                <Route path="grading-presets" element={<AdminGradingPresets />} />
                <Route path="announcements" element={<AdminTeacherAnnouncements />} />
                {/* Unknown URLs are redirected instead of rendering the Dashboard accidentally. */}
                <Route path="*" element={<Navigate to="/admin/login" replace />} />
              </Route>
            </Route>

            {/* Academy Admin is a separate tenant role and never satisfies the platform-admin guard. */}
            <Route element={<AcademyAdminRouteGuard />}>
              <Route path="/academy-admin" element={<AcademyAdminLayout />}>
                <Route index element={<Navigate to="/academy-admin/dashboard" replace />} />
                <Route path="dashboard" element={<AcademyAdminOverview />} />
                <Route path="teachers" element={<AcademyTeachersPage />} />
                <Route path="teachers/:uid" element={<AcademyTeacherProfilePage />} />
                <Route path="classes" element={<AcademyClassesPage />} />
                <Route path="students" element={<AcademyStudentsPage />} />
                <Route path="analytics" element={<AcademyAnalyticsPage />} />
                <Route path="alerts" element={<AcademyAlertsPage />} />
                <Route path="fees" element={<AcademyFeesPage />} />
                <Route path="invoices" element={<Navigate to="/academy-admin/fees" replace />} />
                <Route path="payments" element={<Navigate to="/academy-admin/fees" replace />} />
                <Route path="expenses" element={<AcademyExpensesPage />} />
                <Route path="permissions" element={<AcademyTeachersPage />} />
                <Route path="*" element={<Navigate to="/academy-admin/dashboard" replace />} />
              </Route>
            </Route>

            {/* 5. MAIN APPLICATION ROUTES */}
            <Route
              path="/*"
              element={
                <Layout>
                  <Routes>
                    <Route path="dashboard" element={<AcademyPermissionRoute permissions={["dashboard.view"]}><Dashboard /></AcademyPermissionRoute>} />
                    <Route path="classes" element={<FeatureRoute features={["class_management"]}><ClassesPage /></FeatureRoute>} />
                    <Route path="departments" element={<FeatureRoute features={["student_management"]}><DepartmentsPage /></FeatureRoute>} />
                    <Route path="attendance" element={<FeatureRoute feature="attendance_management"><Attendance /></FeatureRoute>} />
                    <Route path="fees" element={<FeatureRoute feature="fee_tracking"><Fees /></FeatureRoute>} />
                    <Route path="reports" element={<FeatureRoute feature="monthly_reports"><Reports /></FeatureRoute>} />
                    <Route path="analytics" element={<FeatureRoute feature="attendance_analytics"><Analytics /></FeatureRoute>} />
                    <Route path="notes" element={<FeatureRoute feature="notes_library"><Notes /></FeatureRoute>} />
                    <Route path="alerts" element={<AcademyPermissionRoute permissions={["alerts.view"]}><Alerts /></AcademyPermissionRoute>} />
                    <Route path="quiz" element={<FeatureRoute feature="quiz_management"><Quiz /></FeatureRoute>} />
                    <Route path="subscription" element={<Navigate to="/dashboard" replace />} />
                    <Route path="settings" element={<AcademyPermissionRoute permissions={["settings.profile"]}><Settings /></AcademyPermissionRoute>} />
                    <Route path="extra-fee" element={<AcademyPermissionRoute permissions={["fees.adjust"]}><ExtraFee /></AcademyPermissionRoute>} />
                    {/* Fallback to the main dashboard */}
                    <Route path="*" element={<Navigate to="/dashboard" replace />} />
                  </Routes>
                </Layout>
              }
            />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

