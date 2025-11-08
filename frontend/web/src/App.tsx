import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { getContractReadOnly, getContractWithSigner } from "./components/useContract";
import "./App.css";
import { useAccount } from 'wagmi';
import { useFhevm, useEncrypt, useDecrypt } from '../fhevm-sdk/src';

interface SurveyData {
  id: string;
  title: string;
  description: string;
  encryptedResponses: number;
  publicResponses: number;
  timestamp: number;
  creator: string;
  isVerified: boolean;
  decryptedValue?: number;
}

interface SurveyStats {
  totalSurveys: number;
  activeSurveys: number;
  totalResponses: number;
  avgCompletion: number;
}

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const [loading, setLoading] = useState(true);
  const [surveys, setSurveys] = useState<SurveyData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creatingSurvey, setCreatingSurvey] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ 
    visible: false, 
    status: "pending", 
    message: "" 
  });
  const [newSurveyData, setNewSurveyData] = useState({ title: "", description: "", responseCount: "" });
  const [selectedSurvey, setSelectedSurvey] = useState<SurveyData | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [operationHistory, setOperationHistory] = useState<string[]>([]);
  const [stats, setStats] = useState<SurveyStats>({
    totalSurveys: 0,
    activeSurveys: 0,
    totalResponses: 0,
    avgCompletion: 0
  });

  const { status, initialize, isInitialized } = useFhevm();
  const { encrypt, isEncrypting } = useEncrypt();
  const { verifyDecryption, isDecrypting } = useDecrypt();

  useEffect(() => {
    const initFhevm = async () => {
      if (!isConnected || isInitialized) return;
      try {
        await initialize();
      } catch (error) {
        console.error('FHEVM init failed:', error);
      }
    };
    initFhevm();
  }, [isConnected, isInitialized, initialize]);

  useEffect(() => {
    const loadData = async () => {
      if (!isConnected) {
        setLoading(false);
        return;
      }
      try {
        await loadSurveys();
      } catch (error) {
        console.error('Load failed:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [isConnected]);

  const addToHistory = (action: string) => {
    setOperationHistory(prev => [`${new Date().toLocaleTimeString()}: ${action}`, ...prev.slice(0, 9)]);
  };

  const loadSurveys = async () => {
    if (!isConnected) return;
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const businessIds = await contract.getAllBusinessIds();
      const surveysList: SurveyData[] = [];
      
      for (const businessId of businessIds) {
        try {
          const businessData = await contract.getBusinessData(businessId);
          surveysList.push({
            id: businessId,
            title: businessData.name,
            description: businessData.description,
            encryptedResponses: Number(businessData.publicValue1) || 0,
            publicResponses: Number(businessData.publicValue2) || 0,
            timestamp: Number(businessData.timestamp),
            creator: businessData.creator,
            isVerified: businessData.isVerified,
            decryptedValue: Number(businessData.decryptedValue) || 0
          });
        } catch (e) {
          console.error('Error loading survey:', e);
        }
      }
      
      setSurveys(surveysList);
      updateStats(surveysList);
      addToHistory(`Loaded ${surveysList.length} surveys`);
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
    }
  };

  const updateStats = (surveyList: SurveyData[]) => {
    const totalSurveys = surveyList.length;
    const activeSurveys = surveyList.filter(s => Date.now()/1000 - s.timestamp < 604800).length;
    const totalResponses = surveyList.reduce((sum, s) => sum + s.encryptedResponses + s.publicResponses, 0);
    const avgCompletion = totalSurveys > 0 ? totalResponses / totalSurveys : 0;

    setStats({
      totalSurveys,
      activeSurveys,
      totalResponses,
      avgCompletion
    });
  };

  const createSurvey = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setCreatingSurvey(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Creating survey with FHE encryption..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("No contract");
      
      const responseCount = parseInt(newSurveyData.responseCount) || 0;
      const businessId = `survey-${Date.now()}`;
      
      const encryptedResult = await encrypt(await contract.getAddress(), address, responseCount);
      
      const tx = await contract.createBusinessData(
        businessId,
        newSurveyData.title,
        encryptedResult.encryptedData,
        encryptedResult.proof,
        responseCount,
        0,
        newSurveyData.description
      );
      
      setTransactionStatus({ visible: true, status: "pending", message: "Waiting for transaction..." });
      await tx.wait();
      
      setTransactionStatus({ visible: true, status: "success", message: "Survey created successfully!" });
      addToHistory(`Created survey: ${newSurveyData.title}`);
      
      await loadSurveys();
      setShowCreateModal(false);
      setNewSurveyData({ title: "", description: "", responseCount: "" });
    } catch (e: any) {
      const errorMessage = e.message?.includes("user rejected") ? "Transaction rejected" : "Creation failed";
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
    } finally { 
      setCreatingSurvey(false); 
    }
  };

  const decryptData = async (surveyId: string): Promise<number | null> => {
    if (!isConnected || !address) return null;
    
    try {
      const contractRead = await getContractReadOnly();
      if (!contractRead) return null;
      
      const surveyData = await contractRead.getBusinessData(surveyId);
      if (surveyData.isVerified) {
        return Number(surveyData.decryptedValue) || 0;
      }
      
      const contractWrite = await getContractWithSigner();
      if (!contractWrite) return null;
      
      const encryptedValueHandle = await contractRead.getEncryptedValue(surveyId);
      
      const result = await verifyDecryption(
        [encryptedValueHandle],
        await contractRead.getAddress(),
        (abiEncodedClearValues: string, decryptionProof: string) => 
          contractWrite.verifyDecryption(surveyId, abiEncodedClearValues, decryptionProof)
      );
      
      const clearValue = result.decryptionResult.clearValues[encryptedValueHandle];
      await loadSurveys();
      addToHistory(`Decrypted survey: ${surveyId}`);
      
      return Number(clearValue);
      
    } catch (e: any) { 
      setTransactionStatus({ visible: true, status: "error", message: "Decryption failed" });
      return null; 
    }
  };

  const handleCheckAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (contract) {
        const available = await contract.isAvailable();
        if (available) {
          setTransactionStatus({ visible: true, status: "success", message: "FHE system is available!" });
          addToHistory("Checked FHE system availability");
        }
      }
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "Availability check failed" });
    }
  };

  const filteredSurveys = surveys.filter(survey =>
    survey.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    survey.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!isConnected) {
    return (
      <div className="app-container">
        <header className="app-header">
          <div className="logo">
            <h1>SurveyChain FHE 🔐</h1>
            <p>Confidential Survey Tool</p>
          </div>
          <ConnectButton />
        </header>
        
        <div className="connection-prompt">
          <div className="connection-content">
            <div className="connection-icon">🔒</div>
            <h2>Connect Wallet to Access Encrypted Surveys</h2>
            <p>Your survey responses are protected with Fully Homomorphic Encryption</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isInitialized) {
    return (
      <div className="loading-screen">
        <div className="fhe-spinner"></div>
        <p>Initializing FHE Encryption System...</p>
      </div>
    );
  }

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Loading encrypted surveys...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo-section">
          <h1>SurveyChain FHE</h1>
          <span className="tagline">Confidential Surveys 🔐</span>
        </div>
        
        <div className="header-actions">
          <button className="availability-btn" onClick={handleCheckAvailability}>
            Check FHE Status
          </button>
          <ConnectButton />
        </div>
      </header>

      <div className="main-content">
        <div className="stats-panel">
          <div className="stat-card">
            <div className="stat-value">{stats.totalSurveys}</div>
            <div className="stat-label">Total Surveys</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.activeSurveys}</div>
            <div className="stat-label">Active</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.totalResponses}</div>
            <div className="stat-label">Encrypted Responses</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.avgCompletion.toFixed(1)}</div>
            <div className="stat-label">Avg Completion</div>
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <h2>Encrypted Surveys</h2>
            <div className="header-controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search surveys..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <button 
                className="create-btn"
                onClick={() => setShowCreateModal(true)}
              >
                + New Survey
              </button>
              <button 
                className="refresh-btn"
                onClick={loadSurveys}
                disabled={isRefreshing}
              >
                {isRefreshing ? "↻" : "↻"}
              </button>
            </div>
          </div>

          <div className="surveys-grid">
            {filteredSurveys.map((survey, index) => (
              <div 
                key={survey.id}
                className="survey-card"
                onClick={() => setSelectedSurvey(survey)}
              >
                <div className="survey-header">
                  <h3>{survey.title}</h3>
                  <span className={`status-badge ${survey.isVerified ? 'verified' : 'encrypted'}`}>
                    {survey.isVerified ? '✅ Verified' : '🔒 Encrypted'}
                  </span>
                </div>
                <p className="survey-desc">{survey.description}</p>
                <div className="survey-meta">
                  <span>Responses: {survey.encryptedResponses}</span>
                  <span>{new Date(survey.timestamp * 1000).toLocaleDateString()}</span>
                </div>
                {survey.isVerified && survey.decryptedValue && (
                  <div className="decrypted-value">
                    Average Score: {survey.decryptedValue}
                  </div>
                )}
              </div>
            ))}
          </div>

          {filteredSurveys.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">📊</div>
              <h3>No surveys found</h3>
              <p>Create your first encrypted survey to get started</p>
              <button 
                className="create-btn"
                onClick={() => setShowCreateModal(true)}
              >
                Create Survey
              </button>
            </div>
          )}
        </div>

        <div className="history-panel">
          <h3>Operation History</h3>
          <div className="history-list">
            {operationHistory.map((entry, index) => (
              <div key={index} className="history-entry">
                {entry}
              </div>
            ))}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Create New Survey</h2>
              <button onClick={() => setShowCreateModal(false)}>×</button>
            </div>
            
            <div className="modal-body">
              <div className="fhe-notice">
                <span>🔐</span>
                <p>Survey responses will be encrypted using FHE technology</p>
              </div>

              <div className="form-group">
                <label>Survey Title</label>
                <input 
                  type="text" 
                  value={newSurveyData.title}
                  onChange={(e) => setNewSurveyData({...newSurveyData, title: e.target.value})}
                  placeholder="Enter survey title..."
                />
              </div>

              <div className="form-group">
                <label>Description</label>
                <textarea 
                  value={newSurveyData.description}
                  onChange={(e) => setNewSurveyData({...newSurveyData, description: e.target.value})}
                  placeholder="Describe your survey..."
                />
              </div>

              <div className="form-group">
                <label>Expected Responses (Encrypted)</label>
                <input 
                  type="number" 
                  value={newSurveyData.responseCount}
                  onChange={(e) => setNewSurveyData({...newSurveyData, responseCount: e.target.value})}
                  placeholder="Enter expected number of responses..."
                />
                <small>This value will be encrypted with FHE</small>
              </div>
            </div>

            <div className="modal-footer">
              <button 
                onClick={() => setShowCreateModal(false)}
                className="cancel-btn"
              >
                Cancel
              </button>
              <button 
                onClick={createSurvey}
                disabled={creatingSurvey || !newSurveyData.title}
                className="submit-btn"
              >
                {creatingSurvey ? "Creating..." : "Create Survey"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedSurvey && (
        <div className="modal-overlay">
          <div className="survey-modal">
            <div className="modal-header">
              <h2>{selectedSurvey.title}</h2>
              <button onClick={() => setSelectedSurvey(null)}>×</button>
            </div>
            
            <div className="modal-body">
              <div className="survey-info">
                <p>{selectedSurvey.description}</p>
                <div className="info-grid">
                  <div className="info-item">
                    <label>Creator</label>
                    <span>{selectedSurvey.creator.substring(0, 8)}...{selectedSurvey.creator.substring(36)}</span>
                  </div>
                  <div className="info-item">
                    <label>Created</label>
                    <span>{new Date(selectedSurvey.timestamp * 1000).toLocaleString()}</span>
                  </div>
                  <div className="info-item">
                    <label>Encrypted Responses</label>
                    <span>{selectedSurvey.encryptedResponses}</span>
                  </div>
                  <div className="info-item">
                    <label>Status</label>
                    <span className={selectedSurvey.isVerified ? 'verified' : 'encrypted'}>
                      {selectedSurvey.isVerified ? 'Verified' : 'Encrypted'}
                    </span>
                  </div>
                </div>
              </div>

              {selectedSurvey.isVerified && selectedSurvey.decryptedValue && (
                <div className="results-section">
                  <h3>Statistical Results</h3>
                  <div className="result-chart">
                    <div className="chart-bar">
                      <div 
                        className="bar-fill" 
                        style={{ width: `${Math.min(100, selectedSurvey.decryptedValue)}%` }}
                      >
                        Average Score: {selectedSurvey.decryptedValue}
                      </div>
                    </div>
                  </div>
                  <p className="result-note">
                    🔐 Individual responses remain encrypted. Only statistical results are visible.
                  </p>
                </div>
              )}

              <div className="action-section">
                <button 
                  onClick={async () => {
                    const result = await decryptData(selectedSurvey.id);
                    if (result !== null) {
                      setSelectedSurvey({...selectedSurvey, isVerified: true, decryptedValue: result});
                    }
                  }}
                  disabled={isDecrypting || selectedSurvey.isVerified}
                  className="decrypt-btn"
                >
                  {isDecrypting ? "Decrypting..." : selectedSurvey.isVerified ? "✅ Verified" : "🔓 Verify Results"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className={`transaction-toast ${transactionStatus.status}`}>
          <div className="toast-content">
            <span className="toast-icon">
              {transactionStatus.status === "success" ? "✓" : 
               transactionStatus.status === "error" ? "✕" : "⏳"}
            </span>
            {transactionStatus.message}
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <p>SurveyChain FHE - Protecting your privacy with Fully Homomorphic Encryption</p>
          <div className="footer-links">
            <a href="#faq">FAQ</a>
            <a href="#docs">Documentation</a>
            <a href="#privacy">Privacy Policy</a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;


