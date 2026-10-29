describe('login', () => {
  it('real defect', () => {
    cy.visit('/');
    cy.get('[data-test="checkout"]').click();
  });
});
