import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { LoginPage } from '../pages/Login/LoginPage';
import { MachinesPage } from '../pages/Machines/MachinesPage';
import { SoftwarePage } from '../pages/Software/SoftwarePage';
import { NewDeploymentPage } from '../pages/Deployments/NewDeploymentPage';
import { DeploymentDetailsPage } from '../pages/Deployments/DeploymentDetailsPage';
import { MonitoringPage } from '../pages/Monitoring/MonitoringPage';
import { DashboardPage } from '../pages/Dashboard/DashboardPage';
import { HistoryPage } from '../pages/History/HistoryPage';
import { ProtectedRoute } from './ProtectedRoute';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/monitoring" element={<MonitoringPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/software" element={<SoftwarePage />} />
          <Route path="/deployments/new" element={<NewDeploymentPage />} />
          <Route path="/deployments/:id" element={<DeploymentDetailsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
