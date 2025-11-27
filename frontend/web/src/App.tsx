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
  question: string;
  encryptedResponse: string;
  publicValue1: number;
  publicValue2: number;
  timestamp: number;
  creator: string;
  isVerified?: boolean;
  decryptedValue?: number;
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
  const [newSurveyData, setNewSurveyData] = useState({ title: "", question: "", response: "" });
  const [selectedSurvey, setSelectedSurvey] = useState<SurveyData | null>(null);
  const [decryptedResponse, setDecryptedResponse] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [contractAddress, setContractAddress] = useState("");
  const [fhevmInitializing, setFhevmInitializing] = useState(false);
  const [stats, setStats] = useState({ total: 0, verified: 0, avgScore: 0 });
  const [searchTerm, setSearchTerm] = useState("");

  const { status, initialize, isInitialized } = useFhevm();
  const { encrypt, isEncrypting } = useEncrypt();
  const { verifyDecryption, isDecrypting: fheIsDecrypting } = useDecrypt();

  useEffect(() => {
    const initFhevmAfterConnection = async () => {
      if (!isConnected || isInitialized || fhevmInitializing) return;
      
      try {
        setFhevmInitializing(true);
        await initialize();
      } catch (error) {
        setTransactionStatus({ 
          visible: true, 
          status: "error", 
          message: "FHEVM initialization failed" 
        });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      } finally {
        setFhevmInitializing(false);
      }
    };

    initFhevmAfterConnection();
  }, [isConnected, isInitialized, initialize, fhevmInitializing]);

  useEffect(() => {
    const loadDataAndContract = async () => {
      if (!isConnected) {
        setLoading(false);
        return;
      }
      
      try {
        await loadData();
        const contract = await getContractReadOnly();
        if (contract) setContractAddress(await contract.getAddress());
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadDataAndContract();
  }, [isConnected]);

  const loadData = async () => {
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
            question: businessData.description,
            encryptedResponse: businessId,
            timestamp: Number(businessData.timestamp),
            creator: businessData.creator,
            publicValue1: Number(businessData.publicValue1) || 0,
            publicValue2: Number(businessData.publicValue2) || 0,
            isVerified: businessData.isVerified,
            decryptedValue: Number(businessData.decryptedValue) || 0
          });
        } catch (e) {
          console.error('Error loading survey data:', e);
        }
      }
      
      setSurveys(surveysList);
      updateStats(surveysList);
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
    }
  };

  const updateStats = (surveyList: SurveyData[]) => {
    const total = surveyList.length;
    const verified = surveyList.filter(s => s.isVerified).length;
    const avgScore = total > 0 ? surveyList.reduce((sum, s) => sum + s.publicValue1, 0) / total : 0;
    setStats({ total, verified, avgScore });
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
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const responseValue = parseInt(newSurveyData.response) || 0;
      const businessId = `survey-${Date.now()}`;
      
      const encryptedResult = await encrypt(contractAddress, address, responseValue);
      
      const tx = await contract.createBusinessData(
        businessId,
        newSurveyData.title,
        encryptedResult.encryptedData,
        encryptedResult.proof,
        parseInt(newSurveyData.response) || 0,
        0,
        newSurveyData.question
      );
      
      setTransactionStatus({ visible: true, status: "pending", message: "Waiting for transaction confirmation..." });
      await tx.wait();
      
      setTransactionStatus({ visible: true, status: "success", message: "Survey created successfully!" });
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
      
      await loadData();
      setShowCreateModal(false);
      setNewSurveyData({ title: "", question: "", response: "" });
    } catch (e: any) {
      const errorMessage = e.message?.includes("user rejected transaction") 
        ? "Transaction rejected" 
        : "Submission failed";
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreatingSurvey(false); 
    }
  };

  const decryptData = async (businessId: string): Promise<number | null> => {
    if (!isConnected || !address) return null;
    
    setIsDecrypting(true);
    try {
      const contractRead = await getContractReadOnly();
      if (!contractRead) return null;
      
      const businessData = await contractRead.getBusinessData(businessId);
      if (businessData.isVerified) {
        const storedValue = Number(businessData.decryptedValue) || 0;
        setTransactionStatus({ visible: true, status: "success", message: "Data already verified" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
        return storedValue;
      }
      
      const contractWrite = await getContractWithSigner();
      if (!contractWrite) return null;
      
      const encryptedValueHandle = await contractRead.getEncryptedValue(businessId);
      
      const result = await verifyDecryption(
        [encryptedValueHandle],
        contractAddress,
        (abiEncodedClearValues: string, decryptionProof: string) => 
          contractWrite.verifyDecryption(businessId, abiEncodedClearValues, decryptionProof)
      );
      
      setTransactionStatus({ visible: true, status: "pending", message: "Verifying decryption..." });
      
      const clearValue = result.decryptionResult.clearValues[encryptedValueHandle];
      
      await loadData();
      
      setTransactionStatus({ visible: true, status: "success", message: "Data decrypted successfully!" });
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
      
      return Number(clearValue);
      
    } catch (e: any) { 
      if (e.message?.includes("Data already verified")) {
        setTransactionStatus({ visible: true, status: "success", message: "Data is already verified" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
        await loadData();
        return null;
      }
      
      setTransactionStatus({ visible: true, status: "error", message: "Decryption failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const available = await contract.isAvailable();
      setTransactionStatus({ visible: true, status: "success", message: "System is available!" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "Availability check failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const filteredSurveys = surveys.filter(survey =>
    survey.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    survey.question.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!isConnected) {
    return (
      <div className="app-container">
        <header className="app-header">
          <div className="logo">
            <h1>SurveyChain FHE 🔐</h1>
          </div>
          <div className="header-actions">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </header>
        
        <div className="connection-prompt">
          <div className="connection-content">
            <div className="connection-icon">🔐</div>
            <h2>Connect Your Wallet</h2>
            <p>Please connect your wallet to access the confidential survey system.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isInitialized || fhevmInitializing) {
    return (
      <div className="loading-screen">
        <div className="fhe-spinner"></div>
        <p>Initializing FHE System...</p>
      </div>
    );
  }

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Loading survey system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>SurveyChain FHE 🔐</h1>
          <p>Confidential Survey Tool</p>
        </div>
        
        <div className="header-actions">
          <button onClick={checkAvailability} className="check-btn">
            Check System
          </button>
          <button onClick={() => setShowCreateModal(true)} className="create-btn">
            + New Survey
          </button>
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
        </div>
      </header>
      
      <div className="main-content">
        <div className="stats-panels">
          <div className="stat-panel">
            <h3>Total Surveys</h3>
            <div className="stat-value">{stats.total}</div>
          </div>
          <div className="stat-panel">
            <h3>Verified Responses</h3>
            <div className="stat-value">{stats.verified}</div>
          </div>
          <div className="stat-panel">
            <h3>Avg Score</h3>
            <div className="stat-value">{stats.avgScore.toFixed(1)}</div>
          </div>
        </div>

        <div className="search-section">
          <input
            type="text"
            placeholder="Search surveys..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
          <button onClick={loadData} className="refresh-btn" disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div className="surveys-grid">
          {filteredSurveys.length === 0 ? (
            <div className="no-surveys">
              <p>No surveys found</p>
              <button onClick={() => setShowCreateModal(true)} className="create-btn">
                Create First Survey
              </button>
            </div>
          ) : (
            filteredSurveys.map((survey, index) => (
              <div 
                className={`survey-card ${selectedSurvey?.id === survey.id ? "selected" : ""}`}
                key={index}
                onClick={() => setSelectedSurvey(survey)}
              >
                <div className="card-header">
                  <h3>{survey.title}</h3>
                  <span className={`status ${survey.isVerified ? "verified" : "pending"}`}>
                    {survey.isVerified ? "✅ Verified" : "🔓 Pending"}
                  </span>
                </div>
                <p className="question">{survey.question}</p>
                <div className="card-footer">
                  <span>Score: {survey.publicValue1}/10</span>
                  <span>{new Date(survey.timestamp * 1000).toLocaleDateString()}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreateSurvey 
          onSubmit={createSurvey} 
          onClose={() => setShowCreateModal(false)} 
          creating={creatingSurvey} 
          surveyData={newSurveyData} 
          setSurveyData={setNewSurveyData}
          isEncrypting={isEncrypting}
        />
      )}
      
      {selectedSurvey && (
        <SurveyDetailModal 
          survey={selectedSurvey} 
          onClose={() => {
            setSelectedSurvey(null);
            setDecryptedResponse(null);
          }} 
          decryptedResponse={decryptedResponse}
          isDecrypting={isDecrypting || fheIsDecrypting}
          decryptData={() => decryptData(selectedSurvey.id)}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
    </div>
  );
};

const ModalCreateSurvey: React.FC<{
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  surveyData: any;
  setSurveyData: (data: any) => void;
  isEncrypting: boolean;
}> = ({ onSubmit, onClose, creating, surveyData, setSurveyData, isEncrypting }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    if (name === 'response') {
      const intValue = value.replace(/[^\d]/g, '');
      setSurveyData({ ...surveyData, [name]: intValue });
    } else {
      setSurveyData({ ...surveyData, [name]: value });
    }
  };

  return (
    <div className="modal-overlay">
      <div className="create-survey-modal">
        <div className="modal-header">
          <h2>New Confidential Survey</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <strong>FHE 🔐 Protection</strong>
            <p>Survey responses are encrypted with Zama FHE technology</p>
          </div>
          
          <div className="form-group">
            <label>Survey Title *</label>
            <input 
              type="text" 
              name="title" 
              value={surveyData.title} 
              onChange={handleChange} 
              placeholder="Enter survey title..." 
            />
          </div>
          
          <div className="form-group">
            <label>Survey Question *</label>
            <textarea 
              name="question" 
              value={surveyData.question} 
              onChange={handleChange} 
              placeholder="Enter your question..." 
              rows={3}
            />
          </div>
          
          <div className="form-group">
            <label>Response (Integer 1-10) *</label>
            <input 
              type="number" 
              min="1" 
              max="10" 
              name="response" 
              value={surveyData.response} 
              onChange={handleChange} 
              placeholder="Enter response 1-10..." 
            />
            <div className="data-type-label">FHE Encrypted Integer</div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={creating || isEncrypting || !surveyData.title || !surveyData.question || !surveyData.response} 
            className="submit-btn"
          >
            {creating || isEncrypting ? "Encrypting..." : "Create Survey"}
          </button>
        </div>
      </div>
    </div>
  );
};

const SurveyDetailModal: React.FC<{
  survey: SurveyData;
  onClose: () => void;
  decryptedResponse: number | null;
  isDecrypting: boolean;
  decryptData: () => Promise<number | null>;
}> = ({ survey, onClose, decryptedResponse, isDecrypting, decryptData }) => {
  const handleDecrypt = async () => {
    if (decryptedResponse !== null) return;
    await decryptData();
  };

  return (
    <div className="modal-overlay">
      <div className="survey-detail-modal">
        <div className="modal-header">
          <h2>Survey Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="survey-info">
            <div className="info-item">
              <span>Title:</span>
              <strong>{survey.title}</strong>
            </div>
            <div className="info-item">
              <span>Question:</span>
              <strong>{survey.question}</strong>
            </div>
            <div className="info-item">
              <span>Creator:</span>
              <strong>{survey.creator.substring(0, 6)}...{survey.creator.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(survey.timestamp * 1000).toLocaleDateString()}</strong>
            </div>
          </div>
          
          <div className="data-section">
            <h3>Encrypted Response</h3>
            
            <div className="data-row">
              <div className="data-label">Response Value:</div>
              <div className="data-value">
                {survey.isVerified && survey.decryptedValue ? 
                  `${survey.decryptedValue} (Verified)` : 
                  decryptedResponse !== null ? 
                  `${decryptedResponse} (Decrypted)` : 
                  "🔒 FHE Encrypted"
                }
              </div>
              <button 
                className={`decrypt-btn ${(survey.isVerified || decryptedResponse !== null) ? 'decrypted' : ''}`}
                onClick={handleDecrypt} 
                disabled={isDecrypting}
              >
                {isDecrypting ? "Decrypting..." : survey.isVerified ? "✅ Verified" : "🔓 Decrypt"}
              </button>
            </div>
            
            <div className="fhe-info">
              <div className="fhe-icon">🔐</div>
              <div>
                <strong>FHE Protected Response</strong>
                <p>Individual responses are encrypted. Only statistical analysis is possible.</p>
              </div>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;