import { generateUUID } from '../utils/uuid';
import { putPosRecord } from './posDataAccess';

export const logAction = async (
  userName: string,
  operationName: string,
  type: string,
  details: string,
  quantity: number,
  value: number,
  productName?: string,
  branchId?: number
) => {
  try {
    await putPosRecord('auditLogs', {
      id: generateUUID(),
      date: new Date().toISOString(),
      userName,
      productName,
      operationName,
      type,
      details,
      quantity,
      value,
      branchId,
      syncStatus: 'pending',
    }, 'pending');
  } catch (error) {
    console.error('Error logging action:', error);
  }
};
