import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { LoginPage } from '../pages/Login/LoginPage';
import { MachinesPage } from '../pages/Machines/MachinesPage';
import { SoftwarePage } from '../pages/Software/SoftwarePage';
import { NewDeploymentPage } from '../pages/Deployments/NewDeploymentPage';
import { ProtectedRoute } from './ProtectedRoute';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/software" element={<SoftwarePage />} />
          <Route path="/deployments/new" element={<NewDeploymentPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/machines" replace />} />
    </Routes>
  );
}
